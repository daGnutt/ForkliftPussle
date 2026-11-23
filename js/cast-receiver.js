const frame = document.getElementById('game');
const receiverError = document.getElementById('receiverError');

function fail(message) {
  receiverError.textContent = message;
  receiverError.hidden = false;
  frame.hidden = true;
  console.error(message);
}

const receiverApi = globalThis.cast?.framework?.CastReceiverContext;
if (!receiverApi) {
  fail('Google Cast receiver SDK did not load. Check the receiver internet connection.');
} else {
  try {
    const context = receiverApi.getInstance();
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'ended') context.stop();
      else if (event.data.type === 'error' && typeof event.data.message === 'string') fail(event.data.message);
    });
    context.start({ disableIdleTimeout: true });
    frame.src = new URL('index.html?observer&castReceiver=1', location.href).href;
  } catch (e) {
    fail(`Could not start the Cast receiver: ${e.message}`);
  }
}
