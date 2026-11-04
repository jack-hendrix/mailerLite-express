# mailerLite-express

This project sets up an API using Node.js and Express to manage subscribers with MailerLite. The API allows adding subscribers and assigning them to a specific group.

## Requirements
- Node.js (v18 or later)
- MailerLite API Key
- ```.env``` file for environment variables.
## Installation
Clone the repository:
```bash
git clone https://github.com/kenneth-hendrix/mailerLite-express.git
cd mailerLite-express
```
Install dependencies:
```bash
npm install
```
Create a .env file in the project root and add the following variables:
```javascript
PORT=3000
MAILERLITE_API_KEY=<your-mailerlite-api-key>
GROUP_ID=<your-mailerlite-group-id>
IMGUR_CLIENT_ID=<your-imgur-client-id>
FIREBASE_PROJECT_ID=<firebase-project-id>
ADMIN_UID=<firebase-uid-allowed-to-upload>
ALLOWED_ORIGINS=http://localhost:4200
```
`FIREBASE_PROJECT_ID` and `ADMIN_UID` are required for image uploads; without
them `/api/upload-image` returns 503. `ALLOWED_ORIGINS` is a comma separated
list of origins allowed to call the API from a browser (defaults to
`http://localhost:4200`). Requests proxied by nginx on the same host are
same-origin and don't need to be listed.
Start the server:
```bash
npm run start
```
or start the test server:
```bash
npm run test
```
Run the unit tests:
```bash
npm run test:unit
```
The server will run on http://localhost:3000.
## Endpoints
**POST** ```/api/subscriber```\
Add or update a subscriber and assign them to a group.\
Request Body:
```json
{
  "email": "subscriber@example.com"
}
```
**Response**
- Success (200): `{ "success": true }`
- 400: Missing or invalid email.
- 429: Too many requests (10 per 15 minutes per client).
- Error (4xx/5xx): Returns an error message with the corresponding HTTP status.

**POST** ```/api/upload-image```\
Upload an image to Imgur. Admin only.\
Headers: `Authorization: Bearer <Firebase ID token>`\
Body: `multipart/form-data` with an `image` file (image types only, 10 MB max).

**Response**
- Success (200): `{ "success": true, "imageUrl": "..." }`
- 401: Missing or invalid token. 403: Token is not for `ADMIN_UID`.
- 400: No image. 413: Image too large. 429: Too many requests.

## Usage Example
Send a POST request to /api/subscriber using a tool like Postman or curl:

```bash 
curl -X POST http://localhost:3000/api/subscriber -H "Content-Type: application/json" -d '{"email": "subscriber@example.com"}'
```
## Dependencies

- dotenv: Loads environment variables from a .env file.
- @mailerlite/mailerlite-nodejs: MailerLite API client. 
- express: Web framework for Node.js. 
- cors: Enables Cross-Origin Resource Sharing.
- multer: Parses image uploads.
- axios: Uploads images to Imgur.
- jose: Verifies Firebase ID tokens.
- express-rate-limit: Rate limits the endpoints.

