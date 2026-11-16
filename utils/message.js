// Promise wrapper so callers don't hand-roll the callback dance. Resolves
// undefined when no listener answers (SW down / port closed); reading
// lastError keeps Chrome from logging an unchecked-lastError warning.
export function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}