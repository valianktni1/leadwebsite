const $ = id => document.getElementById(id);
let setup = false;
async function init() {
  try {
    const response = await fetch('/api/auth/status'); if (!response.ok) throw new Error('Could not load account status. Refresh to try again.');
    const status = await response.json(); if (status.authenticated) { location.replace('/admin'); return; }
    setup = status.needsSetup;
    $('auth-title').textContent = setup ? 'Make this studio yours.' : 'Good to see you again.';
    $('auth-description').textContent = setup ? 'Create your admin account. Choose the email and password you’ll use to manage your demos.' : 'Sign in to your website demo collection.';
    $('auth-submit').textContent = setup ? 'Create admin account' : 'Sign in';
    $('password').autocomplete = setup ? 'new-password' : 'current-password';
    $('password').minLength = setup ? 12 : 1;
    $('password-help').textContent = setup ? 'Choose a unique password with at least 12 characters.' : '';
    $('confirm-label').hidden = !setup; $('confirm-password').required = setup;
    $('auth-form').hidden = false;
  } catch (error) { $('auth-description').textContent = error.message; }
}
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-error').hidden = true;
  if (setup && $('password').value !== $('confirm-password').value) { $('auth-error').textContent = 'The passwords do not match.'; $('auth-error').hidden = false; return; }
  $('auth-submit').disabled = true;
  try {
    const response = await fetch(`/api/auth/${setup ? 'setup' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
    location.replace('/admin');
  } catch (error) { $('auth-error').textContent = error.message; $('auth-error').hidden = false; }
  finally { $('auth-submit').disabled = false; }
};
init();
