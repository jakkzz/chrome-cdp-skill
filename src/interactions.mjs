import { setTimeout as delay } from 'node:timers/promises';

async function evaluate(page, targetId, expression, options) {
  const result = await page(targetId, 'Runtime.evaluate', { expression, returnByValue: true }, options);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Page inspection failed');
  return result.result.value;
}

export async function viewportPoint(page, targetId, { selector, x, y, defaultCenter = false }) {
  if (selector && (x !== undefined || y !== undefined)) throw new Error('Choose a selector or coordinates, not both');
  if ((x === undefined) !== (y === undefined)) throw new Error('Supply both x and y coordinates');
  if (!selector && x === undefined && !defaultCenter) throw new Error('Supply a selector or coordinates');
  return evaluate(page, targetId, `(() => {
    const input = ${JSON.stringify({ selector, x, y })};
    let x = input.x, y = input.y;
    if (input.selector) {
      const matches = document.querySelectorAll(input.selector);
      if (matches.length !== 1) throw new Error('Selector must match exactly one element');
      const element = matches[0], rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility !== 'visible') throw new Error('Element is not visible');
      x = rect.left + rect.width / 2; y = rect.top + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top !== element && !element.contains(top)) throw new Error('Element is obscured or outside the viewport');
    } else if (x === undefined) {
      x = innerWidth / 2; y = innerHeight / 2;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('Coordinates are outside the CSS viewport');
    return { x, y };
  })()`);
}

export async function scrollPage(page, targetId, { deltaX = 0, deltaY = 0, ...position }) {
  if (!deltaX && !deltaY) throw new Error('Supply a non-zero scroll delta');
  const point = await viewportPoint(page, targetId, { ...position, defaultCenter: true });
  await page(targetId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY });
  return { dispatched: true, ...point, deltaX, deltaY, note: 'Wheel input dispatched; observe the new state. Nested panes scroll under the pointer.' };
}

export async function dragPointer(page, targetId, options, signal) {
  const { fromSelector, fromX, fromY, toSelector, toX, toY, steps = 12, durationMs = 300 } = options;
  const from = await viewportPoint(page, targetId, { selector: fromSelector, x: fromX, y: fromY });
  const to = await viewportPoint(page, targetId, { selector: toSelector, x: toX, y: toY });
  let current = from;
  let pressAttempted = false;
  let failure;
  try {
    signal?.throwIfAborted();
    await page(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from, button: 'none', buttons: 0 });
    signal?.throwIfAborted();
    pressAttempted = true;
    await page(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= steps; step++) {
      if (durationMs) await delay(durationMs / steps, undefined, { signal });
      signal?.throwIfAborted();
      current = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps };
      await page(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...current, button: 'left', buttons: 1 });
    }
  } catch (error) { failure = error; }
  // End an attempted gesture even on cancellation; this is cleanup, not a retry
  // of mousePressed. The page callback still enforces current tab ownership.
  if (pressAttempted) {
    try {
      await page(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...current, button: 'left', buttons: 0, clickCount: 1 });
    } catch (error) {
      throw new Error(`Drag cleanup failed: ${error.message}. Pointer state is uncertain; inspect before another action.${failure ? ` Original error: ${failure.message}` : ''}`);
    }
  }
  if (failure) throw new Error(`Drag interrupted: ${failure.message}. The gesture may have changed the page; inspect before repeating.`);
  return { dispatched: true, from, to, note: 'Pointer gesture completed; inspect its result. File drops and protocol-intercepted HTML drag payloads are not supported.' };
}

export async function selectOptions(page, targetId, { selector, values, labels }) {
  if ((values === undefined) === (labels === undefined)) throw new Error('Supply exactly one of values or labels');
  const requested = values ?? labels;
  if (new Set(requested).size !== requested.length) throw new Error('Selection values or labels must be unique');
  // Check unique visible targeting before changing any native select state.
  await viewportPoint(page, targetId, { selector });
  return evaluate(page, targetId, `(() => {
    const selector = ${JSON.stringify(selector)}, requested = ${JSON.stringify(requested)}, matchByLabel = ${labels !== undefined};
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error('Selector must match exactly one element');
    const select = matches[0];
    if (!(select instanceof HTMLSelectElement)) throw new Error('Only native HTML select elements are supported; use click/key tools for custom dropdowns');
    if (select.matches(':disabled')) throw new Error('Dropdown is disabled');
    if (!select.multiple && requested.length !== 1) throw new Error('A single-select dropdown accepts exactly one value or label');
    const options = Array.from(select.options);
    const chosen = requested.map(value => {
      const matches = options.filter(option => (matchByLabel ? option.label : option.value) === value);
      if (matches.length !== 1) throw new Error('Each requested value or label must match exactly one option');
      const option = matches[0];
      if (option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) throw new Error('Requested option is disabled');
      return option;
    });
    if (select.multiple) {
      const setter = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set;
      for (const option of options) setter.call(option, chosen.includes(option));
    } else {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(select, options.indexOf(chosen[0]));
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const current = document.querySelectorAll(selector);
    if (current.length !== 1 || !(current[0] instanceof HTMLSelectElement)) throw new Error('Dropdown changed after selection; inspect the page before repeating');
    const selected = Array.from(current[0].selectedOptions);
    const selectedValues = selected.map(option => option.value), selectedLabels = selected.map(option => option.label);
    const retained = matchByLabel ? selectedLabels : selectedValues;
    if (retained.length !== requested.length || requested.some(value => !retained.includes(value))) throw new Error('Dropdown did not retain the selection; inspect before repeating');
    return { selectedValues, selectedLabels, note: 'Native input/change events dispatched; this does not confirm backend persistence.' };
  })()`);
}

export async function waitForReady(page, targetId, {
  readyState = 'complete', selector, text, url, timeoutMs = 10000,
}, signal) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastState;
  const expression = `(() => {
    const input = ${JSON.stringify({ readyState, selector, text, url })};
    const state = document.readyState;
    const documentReady = input.readyState === 'complete' ? state === 'complete' : state !== 'loading';
    let selectorReady = true;
    if (input.selector) {
      const matches = document.querySelectorAll(input.selector);
      if (matches.length > 1) throw new Error('Wait selector must match exactly one element');
      const element = matches[0];
      if (!element) selectorReady = false;
      else {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        selectorReady = !!rect.width && !!rect.height && style.display !== 'none' && style.visibility === 'visible'
          && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      }
    }
    const textReady = input.text === undefined || (document.body?.innerText || '').includes(input.text);
    const urlReady = input.url === undefined || location.href === new URL(input.url).href;
    return { ready: documentReady && selectorReady && textReady && urlReady, readyState: state,
      selectorReady, textReady, urlReady, url: location.href };
  })()`;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      lastState = await evaluate(page, targetId, expression, { deadline, signal });
      if (lastState.ready) return { ...lastState, elapsedMs: Date.now() - start };
    } catch (error) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) break;
      // Read-only probes may be repeated across actual navigation context swaps.
      // Invalid selectors, absent ownership and disconnected targets fail at once.
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(100, remaining), undefined, { signal });
  }
  throw new Error(`Page readiness timed out after ${timeoutMs} ms. No action was retried.${lastState ? ` Last observed state: ${JSON.stringify(lastState)}` : ''}`);
}
