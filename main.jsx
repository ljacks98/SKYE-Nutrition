import { createRoot } from "react-dom/client";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import App from "./App.jsx";

// Connect to the Cognito user pool that `sam deploy` created (the values come from .env).
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
      loginWith: { email: true },
    },
  },
});

// <Authenticator> handles sign-in, the first-time password change, MFA setup, and password resets.
// The app only renders once someone is signed in.
createRoot(document.getElementById("root")).render(
  <Authenticator hideSignUp components={{ Header: () => <h1 className="brand">Dialysis Care</h1> }}>
    {({ user, signOut }) => <App user={user} signOut={signOut} />}
  </Authenticator>
);
