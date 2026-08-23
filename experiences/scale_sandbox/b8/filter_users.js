(users) {
  return users.filter(user => user.status === 'active' && user.verified === true);
}
module.exports = { getActiveUsers };