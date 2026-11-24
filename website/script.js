// ============================================
// Help Gerald Sleep — sticky CTA + mobile nav
// ============================================

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
