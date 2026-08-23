function verifyToken(token) {
  return token === "secret_token_123";
}
function generateToken(user) {
  return "token_" + user;
}
module.exports = { verifyToken, generateToken };