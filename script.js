// ============================================
// Help Gerald Sleep — counter + sticky CTA
// ============================================

// The counter reads how many supporters to show from your Google Apps Script
// endpoint, which returns only the row count from your form's response
// sheet — never names, addresses, or signature photos. If that fails for
// any reason (endpoint down, not deployed yet, etc.), it falls back to the
// number in counter.json so the page never breaks.
const COUNTER_ENDPOINT = 'https://script.google.com/macros/s/AKfycbz10hRsSAU52UgowbcbOudLwOu6WCEQN8MlyOBATrLf-IHpZ584bBYTQhLBfddJpKpP/exec';

async function loadCounter() {
  const el = document.getElementById('counterNumber');
  let target = parseInt(el.dataset.target, 10) || 0;

  try {
    const res = await fetch(COUNTER_ENDPOINT, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.count === 'number') target = data.count;
    } else {
      throw new Error('Apps Script endpoint returned an error');
    }
  } catch (err) {
    // Apps Script endpoint unreachable — fall back to the manually
    // edited counter.json instead.
    try {
      const res = await fetch('counter.json', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.count === 'number') target = data.count;
      }
    } catch (err2) {
      // both sources unreachable — fall back to the data-target value
      // already on the element.
    }
  }

  animateCount(el, target);
}

function animateCount(el, target) {
  const duration = 1200;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(eased * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Sticky "sign the petition" button appears once the hero is scrolled past.
function initStickyCta() {
  const cta = document.getElementById('stickyCta');
  const supportSection = document.getElementById('support');
  if (!cta || !supportSection) return;

  window.addEventListener('scroll', () => {
    const pastHero = window.scrollY > window.innerHeight * 0.6;
    const reachedSupport = supportSection.getBoundingClientRect().top < window.innerHeight * 0.5;
    cta.classList.toggle('visible', pastHero && !reachedSupport);
  }, { passive: true });
}

loadCounter();
initStickyCta();

// Mobile nav toggle
function initNavToggle() {
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
  });
}

// Contact form (Formspree) — submits without leaving the page
function initContactForm() {
  const form = document.getElementById('contactForm');
  const status = document.getElementById('formStatus');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Sending…';
    status.className = 'form-status';

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        form.reset();
        status.textContent = "Thanks — your message is on its way.";
        status.className = 'form-status success';
      } else {
        status.textContent = "Something went wrong. Please try again.";
        status.className = 'form-status error';
      }
    } catch (err) {
      status.textContent = "Something went wrong. Please try again.";
      status.className = 'form-status error';
    }
  });
}

initNavToggle();
initContactForm();
