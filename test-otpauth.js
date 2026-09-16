import * as OTPAuth from "otpauth";

// Generate a new TOTP instance
let totp = new OTPAuth.TOTP({
  issuer: "ACME",
  label: "Alice",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  secret: new OTPAuth.Secret({ size: 20 })
});

// Generate a secret
console.log("Secret:", totp.secret.base32);

// Generate a URI
console.log("URI:", totp.toString());

// Generate a token
let token = totp.generate();
console.log("Token:", token);

// Validate a token
let delta = totp.validate({ token, window: 1 });
console.log("Delta:", delta);
