const store = new Map();
function get(key) {
  if (!cache[key]) {
    return null;
  }
  
  // Nếu Date.now() > item.expiry thì xóa item khỏi cache và trả về null
  if (Date.now() > item.expiry) {
    delete cache[key];
    return null;
  }
  
  return cache[key].value;
}
  const item = store.get(key);
  if (!item) return null;
  return item.value;
}
module.exports = { get, store };