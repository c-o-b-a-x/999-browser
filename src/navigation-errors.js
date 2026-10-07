(function registerNavigationErrors(global) {
  function isCanceledNavigation(errorCode, errorDescription, error) {
    return (
      errorCode === -3 ||
      errorDescription === "ERR_ABORTED" ||
      /(?:\(-3\)|ERR_ABORTED)/i.test(error?.message || "")
    );
  }

  const navigationErrors = { isCanceledNavigation };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = navigationErrors;
  } else {
    global.QuietNavigationErrors = navigationErrors;
  }
})(globalThis);
