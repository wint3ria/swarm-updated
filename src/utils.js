function later(delay) {
  return new Promise(function(resolve) {
    setTimeout(resolve, delay);
  });
}

export {
  later,
}