# WiFi Captive Portal

Captive portal with RADIUS for MikroTik.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Run `npm install`
3. Run `npm run init-db`
4. Run `npm run create-admin`
5. Run `npm start`

## Google OAuth

The captive portal supports account sign-in with Google for addresses present in
`oauth_whitelist`. Create an OAuth 2.0 Web application in Google Cloud Console,
add `GOOGLE_CALLBACK_URL` as an authorised redirect URI, then set these values
in `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=https://portal.example.com/auth/google/callback
```

When a guest completes Google sign-in from the captive portal, their device MAC
is authorised for 24 hours before the browser returns to the MikroTik login
endpoint.

## Portal UI

The guest portal is built from shadcn/ui components. During development run the
Express server and `npm run dev:portal` in separate terminals. Use
`npm run build:portal` before deployment to publish the portal assets into
`public/captive-portal`.
