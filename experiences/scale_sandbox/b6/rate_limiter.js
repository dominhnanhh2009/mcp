function getLimit(user) {
  let maxRequests;
  if (user.isPremium === true) {
    maxRequests = 1000;
  } else {
    maxRequests = 100;
  }
  return maxRequests;
}
module.exports = { getLimit };;