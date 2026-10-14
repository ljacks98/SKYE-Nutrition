# Dialysis Care

A small, secure starter system for a dialysis clinic. Staff sign in, add patients, and chart each treatment. The API works out how much fluid was removed and flags readings worth a second look: high blood pressure before treatment, low blood pressure after, or finishing more than 1 kg above dry weight.

## How it fits together

```
Browser (React app)
   │  1. Staff sign in ──────────▶ Amazon Cognito (admin-created accounts, MFA required)
   │  2. Every request carries the sign-in token
   ▼
API Gateway (HTTP API) ── refuses any request without a valid token
   ▼
Lambda: backend/src/app.mjs ── 4 routes, input checks, alerts, audit log
   ▼
DynamoDB ── Patients and Sessions tables (encrypted, point-in-time backups)
```

| File | What it does |
|---|---|
| `backend/template.yaml` | Every AWS resource, in one file (AWS SAM) |
| `backend/src/app.mjs` | The API: list and add patients, list and add treatment sessions |
| `frontend/src/main.jsx` | Connects to Cognito and shows the sign-in screen |
| `frontend/src/api.js` | Calls the API with the signed-in user's token |
| `frontend/src/App.jsx` | The clinic screen: patient list, session form, treatment history |
| `frontend/src/styles.css` | All styling |

## Deploy

You'll need an AWS account, the AWS CLI (signed in with `aws configure`), the AWS SAM CLI, and Node.js 18 or newer.

### 1. Deploy the backend

```bash
cd backend
sam deploy --guided
```

Give the stack a name such as `dialysis-care` and accept the defaults. If SAM asks whether a function "may not have authorization defined", answer `y`: the API's Cognito authorizer protects every route. When it finishes, copy the three Outputs: `ApiUrl`, `UserPoolId`, and `UserPoolClientId`.

There's no `sam build` step, because the function has no npm packages to install. The AWS SDK it uses is built into Lambda's Node.js runtime.

### 2. Create your first staff login

```bash
aws cognito-idp admin-create-user --user-pool-id YOUR_USER_POOL_ID --username you@example.com --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true --desired-delivery-mediums EMAIL
```

Cognito emails you a temporary password. At your first sign-in you'll choose a new password and scan a QR code with an authenticator app such as Google Authenticator or Authy.

### 3. Run the website on your computer

```bash
cd frontend
cp .env.example .env      # then paste the three Outputs into .env
npm install
npm run dev               # then open http://localhost:5173
```

### 4. Put the website online

```bash
npm run build
```

In the AWS console, open AWS Amplify, choose Create new app, then Deploy without Git, and drag in the `dist` folder (or a zip of what's inside it). You'll get an HTTPS address. If you'd rather deploy automatically from GitHub, connect the repo instead, set the app's root folder to `frontend`, and add the three `VITE_` values as environment variables.

Then allow only that address to call your API:

```bash
cd ../backend
sam deploy --parameter-overrides SiteUrl=https://YOUR-SITE.amplifyapp.com
```

Keep the default `SiteUrl=*` while you're still testing from localhost.

## Before you store real patient data

The defaults here are deliberately cautious: only an admin can create accounts, every user needs MFA, both tables are encrypted with point-in-time backups, the Lambda function can read and add records but never delete them, and the audit log records who did what without any medical details.

A system holding real patient records (PHI) still needs more. Accept AWS's Business Associate Addendum (BAA) in AWS Artifact and use only HIPAA-eligible AWS services. Add roles, for example Cognito groups that separate nurses from admins. Turn on a CloudTrail trail and set how long logs are kept. Have the clinical team set the alert limits at the top of `app.mjs`. Finally, complete a security review and a HIPAA risk assessment. Until then, use made-up test patients.

## Clean up

Run `sam delete` in the `backend` folder to remove the AWS resources and their data, then delete the Amplify app in the console.
