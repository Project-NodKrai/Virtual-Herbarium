import { TOTP } from 'otplib';

const authenticator = new TOTP();
console.log("secret:", authenticator.generateSecret());
const secret = authenticator.generateSecret();
console.log("uri:", authenticator.generateURI({ issuer: 'App', label: 'User', secret }));
