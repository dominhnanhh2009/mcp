function validateUser(username, password) {
  if (!username) {
    throw new Error('Username is required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return true;
}
module.exports = { validateUser };