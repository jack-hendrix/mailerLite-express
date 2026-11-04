const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, createFirebaseTokenVerifier } = require("../server");

const PROJECT_ID = "demo-project";
const ADMIN_UID = "admin-uid";

const config = {
  groupId: "group-1",
  firebaseProjectId: PROJECT_ID,
  adminUid: ADMIN_UID,
  allowedOrigins: ["http://localhost:4200"],
};

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function imageForm(bytes = 10, type = "image/png") {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type }), "a.png");
  return form;
}

describe("server", () => {
  let server;
  let url;
  let mailerlite;
  let uploads;
  let verifyToken;

  before(async () => {
    mailerlite = {
      subscribers: { createOrUpdate: async () => ({}) },
      groups: { assignSubscriber: async () => ({}) },
    };
    const app = createApp({
      config,
      mailerlite: {
        subscribers: {
          createOrUpdate: (...args) => mailerlite.subscribers.createOrUpdate(...args),
        },
        groups: {
          assignSubscriber: (...args) => mailerlite.groups.assignSubscriber(...args),
        },
      },
      uploadImage: async (buffer) => {
        uploads.push(buffer);
        return "https://i.imgur.com/abc.png";
      },
      verifyToken: (token) => verifyToken(token),
    });
    ({ server, url } = await startServer(app));
  });

  after(() => server.close());

  beforeEach(() => {
    uploads = [];
    mailerlite.subscribers.createOrUpdate = async () => ({
      data: { data: { id: "sub-1" } },
    });
    mailerlite.groups.assignSubscriber = async () => ({
      status: 200,
      data: { data: { email: "someone@example.com", fields: {} } },
    });
    verifyToken = async (token) => {
      if (token === "admin-token") return { sub: ADMIN_UID };
      if (token === "user-token") return { sub: "someone-else" };
      throw new Error("bad token");
    };
  });

  describe("POST /api/subscriber", () => {
    function subscribe(body, headers = {}) {
      return fetch(`${url}/api/subscriber`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    test("subscribes and adds to the group without echoing subscriber data", async () => {
      let assigned;
      mailerlite.groups.assignSubscriber = async (id, group) => {
        assigned = [id, group];
        return { status: 200, data: { data: { email: "leak@example.com" } } };
      };

      const res = await subscribe(
        { email: "reader@example.com" },
        { "X-Forwarded-For": "10.0.0.1" }
      );

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { success: true });
      assert.deepEqual(assigned, ["sub-1", "group-1"]);
    });

    test("rejects missing or malformed emails", async () => {
      for (const body of [{}, { email: 42 }, { email: "not-an-email" }, { email: `${"a".repeat(250)}@x.com` }]) {
        const res = await subscribe(body, { "X-Forwarded-For": "10.0.0.2" });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
    });

    test("responds even when MailerLite fails without a response", async () => {
      mailerlite.subscribers.createOrUpdate = async () => {
        throw new Error("network down");
      };

      const res = await subscribe(
        { email: "reader@example.com" },
        { "X-Forwarded-For": "10.0.0.3" }
      );

      assert.equal(res.status, 500);
    });

    test("passes through MailerLite client errors", async () => {
      mailerlite.subscribers.createOrUpdate = async () => {
        const error = new Error("invalid");
        error.response = { status: 422, data: {} };
        throw error;
      };

      const res = await subscribe(
        { email: "reader@example.com" },
        { "X-Forwarded-For": "10.0.0.4" }
      );

      assert.equal(res.status, 422);
    });

    test("rejects malformed JSON", async () => {
      const res = await subscribe("{nope", { "X-Forwarded-For": "10.0.0.5" });
      assert.equal(res.status, 400);
    });

    test("rate limits repeated sign ups from one client", async () => {
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        const res = await subscribe(
          { email: `reader${i}@example.com` },
          { "X-Forwarded-For": "10.0.0.6" }
        );
        statuses.push(res.status);
      }
      assert.equal(statuses.filter((s) => s === 200).length, 10);
      assert.equal(statuses.at(-1), 429);
    });
  });

  describe("POST /api/upload-image", () => {
    function uploadImage(headers = {}, form = imageForm()) {
      return fetch(`${url}/api/upload-image`, {
        method: "POST",
        headers,
        body: form,
      });
    }

    test("rejects requests without a token", async () => {
      const res = await uploadImage();
      assert.equal(res.status, 401);
      assert.equal(uploads.length, 0);
    });

    test("rejects invalid tokens", async () => {
      const res = await uploadImage({ Authorization: "Bearer forged" });
      assert.equal(res.status, 401);
      assert.equal(uploads.length, 0);
    });

    test("rejects signed in users who are not the admin", async () => {
      const res = await uploadImage({ Authorization: "Bearer user-token" });
      assert.equal(res.status, 403);
      assert.equal(uploads.length, 0);
    });

    test("uploads for the admin", async () => {
      const res = await uploadImage({ Authorization: "Bearer admin-token" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).imageUrl, "https://i.imgur.com/abc.png");
      assert.equal(uploads.length, 1);
    });

    test("rejects files that are not images", async () => {
      const res = await uploadImage(
        { Authorization: "Bearer admin-token" },
        imageForm(10, "text/html")
      );
      assert.equal(res.status, 400);
      assert.equal(uploads.length, 0);
    });

    test("rejects images over 10 MB", async () => {
      const res = await uploadImage(
        { Authorization: "Bearer admin-token" },
        imageForm(10 * 1024 * 1024 + 1)
      );
      assert.equal(res.status, 413);
      assert.equal(uploads.length, 0);
    });
  });

  test("only allows CORS from configured origins", async () => {
    const allowed = await fetch(`${url}/api/subscriber`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:4200",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:4200"
    );

    const blocked = await fetch(`${url}/api/subscriber`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  });

  test("does not advertise Express", async () => {
    const res = await fetch(`${url}/api/subscriber`, { method: "POST" });
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});

describe("uploads without auth configured", () => {
  test("are refused rather than left open", async () => {
    const app = createApp({
      config: { ...config, adminUid: undefined },
      mailerlite: {},
      uploadImage: async () => "x",
      verifyToken: async () => ({ sub: ADMIN_UID }),
    });
    const { server, url } = await startServer(app);
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${url}/api/upload-image`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token" },
        body: imageForm(),
      });
      assert.equal(res.status, 503);
    } finally {
      console.error = originalError;
      server.close();
    }
  });
});

describe("createFirebaseTokenVerifier", () => {
  let jose;
  let privateKey;
  let otherKey;
  let verify;

  before(async () => {
    jose = await import("jose");
    const pair = await jose.generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherKey = (await jose.generateKeyPair("RS256")).privateKey;
    const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    verify = createFirebaseTokenVerifier(
      PROJECT_ID,
      jose.createLocalJWKSet({ keys: [jwk] })
    );
  });

  function sign(claims = {}, { key = privateKey, alg = "RS256" } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new jose.SignJWT({ auth_time: now - 60, ...claims })
      .setProtectedHeader({ alg, kid: "k1" })
      .setIssuer(claims.iss ?? `https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(claims.aud ?? PROJECT_ID)
      .setSubject(claims.sub ?? ADMIN_UID)
      .setIssuedAt(now - 60)
      .setExpirationTime(claims.exp ?? now + 3600)
      .sign(key);
  }

  test("accepts a valid token", async () => {
    const payload = await verify(await sign());
    assert.equal(payload.sub, ADMIN_UID);
  });

  test("rejects a token signed by another key", async () => {
    await assert.rejects(verify(await sign({}, { key: otherKey })));
  });

  test("rejects a token for another project", async () => {
    await assert.rejects(verify(await sign({ aud: "other-project" })));
    await assert.rejects(
      verify(await sign({ iss: "https://securetoken.google.com/other-project" }))
    );
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    await assert.rejects(verify(await sign({ exp: past })));
  });

  test("rejects a token with a future auth_time", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    await assert.rejects(verify(await sign({ auth_time: future })));
  });

  test("rejects an empty subject", async () => {
    await assert.rejects(verify(await sign({ sub: "" })));
  });

  test("rejects unsigned tokens", async () => {
    const unsigned = new jose.UnsecuredJWT({ auth_time: 1 })
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject(ADMIN_UID)
      .setExpirationTime("1h")
      .encode();
    await assert.rejects(verify(unsigned));
  });
});
