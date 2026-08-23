const { verifyToken } = require('./auth');
console.log("Auth Status:", verifyToken("secret_token_123"));