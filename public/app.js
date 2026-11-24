const $ = id => document.getElementById(id);
let demos = [], selected = [], publicURL = 'https://websites.ivorydigital.uk', editedSlug = false;
let emailDemo = null;
async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status === 401) { location.replace('/admin'); throw new Error('Please sign in again.'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Unable to complete your request.'); return result;
}
const slugify = name => name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
function showNotice(message) { $('notice').textContent = message; $('notice').hidden = false; }
function openUpload() { $('upload-dialog').showModal(); }
$('new-demo').onclick = openUpload;
$('footer-add').onclick = event => { event.preventDefault(); openUpload(); };
$('close-dialog').onclick = () => $('upload-dialog').close();
$('choose-files').onclick = () => $('files').click();
$('choose-folder').onclick = () => $('folder').click();
$('company').oninput = () => { if (!editedSlug) $('slug').value = slugify($('company').value); updateURL(); };
$('slug').oninput = () => { editedSlug = true; updateURL(); };
function updateURL() { $('url-preview').textContent = `${publicURL}/${$('slug').value || 'your-company'}/`; }
function selectFiles(input, folder) {
  selected = [...input.files].map(file => ({ file, path: folder ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name }));
  // macOS and other tools often include hidden metadata that is not part of the website.
  selected = selected.filter(item => !item.path.split('/').some(part => part.startsWith('.')));
  $('file-summary').textContent = `${selected.length} files selected · ${(selected.reduce((n, x) => n + x.file.size, 0) / 1024 / 1024).toFixed(1)} MB`;
}
$('files').onchange = () => selectFiles($('files'), false);
$('folder').onchange = () => selectFiles($('folder'), true);
$('search').oninput = render;
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; }
function render() {
  const grid = $('demos'); grid.replaceChildren(); $('count').textContent = demos.length;
  const query = $('search').value.toLowerCase();
  const filtered = demos.filter(d => `${d.name} ${d.slug}`.toLowerCase().includes(query));
  if (!filtered.length) {
    const empty = element('div', 'empty');
    empty.append(element('span', 'empty-icon', '◇'), element('h3', '', demos.length ? 'No matching demos' : 'Your next client starts here'), element('p', '', demos.length ? 'Try another company name or URL.' : 'Upload your first website demo, then share a link that feels made just for them.'));
    if (!demos.length) { const button = element('button', 'button dark', '+ Add your first demo'); button.onclick = openUpload; empty.append(button); }
    grid.append(empty); return;
  }
  for (const demo of filtered) {
    const card = element('article', 'demo-card');
    const art = element('div', 'card-art');
    art.append(element('span', 'monogram', demo.name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase()), element('span', 'site-label', 'WEBSITE DEMO'));
    const body = element('div', 'card-body');
    const url = element('span', 'site-url', demo.url.replace('https://', '')); url.title = demo.url;
    body.append(element('h3', '', demo.name), url, element('p', 'card-meta', `Added ${new Date(demo.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`));
    const actions = element('div', 'card-actions');
    const preview = element('a', 'button light', 'View demo'); preview.href = demo.url; preview.target = '_blank'; preview.rel = 'noopener noreferrer';
    const copy = element('button', 'button dark', 'Copy link'); copy.onclick = async () => {
      try { await navigator.clipboard.writeText(demo.url); copy.textContent = 'Copied!'; setTimeout(() => copy.textContent = 'Copy link', 2000); }
      catch { showNotice(`Copy this link: ${demo.url}`); }
    };
    const email = element('button', 'button light email-demo', 'Send by email'); email.onclick = async () => {
      emailDemo = demo; $('email-form').reset(); $('email-error').hidden = true;
      $('email-subject').value = `A website idea for ${demo.name}`;
      $('email-message').value = `Hi,\n\nI’ve put together a website concept for ${demo.name} and thought you might like to take a look.\n\nI’d love to hear what you think.\n\nIvory Digital`;
      $('email-link').textContent = demo.url;
      $('email-sender').textContent = 'Loading your saved sender…'; $('send-email').disabled = true; $('email-dialog').showModal();
      try {
        const settings = await request('/api/settings/smtp');
        $('email-sender').textContent = settings.passwordSaved ? `Sending from: ${settings.fromEmail}` : 'Save your SMTP settings using Email settings before sending.';
        $('send-email').disabled = !settings.passwordSaved;
      } catch (error) { $('email-error').textContent = error.message; $('email-error').hidden = false; }
    };
    actions.append(preview, copy); body.append(actions, email); card.append(art, body); grid.append(card);
  }
}
async function load() {
  try {
    const data = await request('/api/demos'); demos = data.demos; publicURL = data.publicURL; updateURL(); render();
  } catch (e) { showNotice(e.message); }
}
const encodeFile = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Unable to read a selected file.')); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
$('upload-form').onsubmit = async event => {
  event.preventDefault(); $('upload-error').hidden = true;
  const button = $('publish');
  try {
    if (!selected.some(f => f.path === 'index.html')) throw new Error('Select index.html or a folder containing index.html at its top level.');
    if (selected.length > 1000 || selected.reduce((n, f) => n + f.file.size, 0) > 50 * 1024 * 1024) throw new Error('Choose up to 1,000 files, totalling no more than 50 MB.');
    button.disabled = true; button.textContent = 'Uploading demo…';
    const files = [];
    for (const item of selected) files.push({ path: item.path, content: await encodeFile(item.file) });
    const response = await fetch('/api/demos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('company').value, slug: $('slug').value, files }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.');
    $('upload-dialog').close(); $('upload-form').reset(); selected = []; editedSlug = false; $('file-summary').textContent = 'No files selected';
    showNotice(`Demo published. Ready to share: ${result.url}`); await load();
  } catch (error) { $('upload-error').textContent = error.message; $('upload-error').hidden = false; }
  finally { button.disabled = false; button.textContent = 'Publish demo'; }
};
$('logout').onclick = async () => { try { await request('/api/auth/logout', {}); location.replace('/admin'); } catch (error) { showNotice(error.message); } };
$('close-smtp').onclick = () => $('smtp-dialog').close();
$('close-email').onclick = () => $('email-dialog').close();
$('email-settings').onclick = async () => {
  $('smtp-dialog').showModal(); $('smtp-error').hidden = true; $('smtp-status').textContent = 'Loading settings…';
  $('save-smtp').disabled = true; $('test-smtp').disabled = true;
  try {
    const settings = await request('/api/settings/smtp');
    $('smtp-name').value = settings.fromName || 'Ivory Digital'; $('smtp-email').value = settings.fromEmail || settings.adminEmail;
    $('smtp-host').value = settings.host || ''; $('smtp-port').value = settings.port || 587; $('smtp-security').value = settings.security || 'starttls';
    $('smtp-user').value = settings.username || ''; $('smtp-password').value = ''; $('smtp-password').required = !settings.passwordSaved;
    $('smtp-password-help').textContent = settings.passwordSaved ? 'Password saved securely. Leave blank to keep it, or enter a replacement.' : 'Your password is encrypted before it is saved.';
    $('test-recipient').textContent = `The test email will go to your admin address: ${settings.adminEmail}`;
    $('smtp-status').textContent = settings.passwordSaved ? `Saved sender: ${settings.fromEmail}. Test emails and demo emails will use this address.` : 'Save your settings before sending a test email.';
    $('save-smtp').disabled = false; $('test-smtp').disabled = !settings.passwordSaved;
  } catch (error) { $('smtp-error').textContent = error.message; $('smtp-error').hidden = false; }
};
for (const input of $('smtp-form').querySelectorAll('input,select')) input.addEventListener('input', () => { $('test-smtp').disabled = true; $('smtp-status').textContent = 'Save your changes before sending a test email.'; });
$('smtp-security').onchange = () => { $('smtp-port').value = $('smtp-security').value === 'tls' ? 465 : 587; };
$('smtp-form').onsubmit = async event => {
  event.preventDefault(); $('smtp-error').hidden = true; $('save-smtp').disabled = true;
  try {
    const saved = await request('/api/settings/smtp', { host: $('smtp-host').value.trim(), port: Number($('smtp-port').value), security: $('smtp-security').value, fromName: $('smtp-name').value, fromEmail: $('smtp-email').value.trim(), username: $('smtp-user').value.trim(), password: $('smtp-password').value });
    $('smtp-password').value = ''; $('smtp-password').required = false;
    $('smtp-password-help').textContent = 'Password saved securely. Leave blank to keep it, or enter a replacement.';
    $('smtp-status').textContent = `Email settings saved. Sending from: ${saved.fromEmail}`; $('test-smtp').disabled = false;
  } catch (error) { $('smtp-error').textContent = error.message; $('smtp-error').hidden = false; }
  finally { $('save-smtp').disabled = false; }
};
$('test-smtp').onclick = async () => {
  $('smtp-error').hidden = true; $('test-smtp').disabled = true; $('save-smtp').disabled = true; $('smtp-status').textContent = 'Sending your test email…';
  try { const result = await request('/api/email/test', {}); $('smtp-status').textContent = result.message; }
  catch (error) { $('smtp-status').textContent = ''; $('smtp-error').textContent = error.message; $('smtp-error').hidden = false; }
  finally { $('test-smtp').disabled = false; $('save-smtp').disabled = false; }
};
$('email-form').onsubmit = async event => {
  event.preventDefault(); if (!emailDemo) return; $('send-email').disabled = true; $('send-email').textContent = 'Sending…'; $('email-error').hidden = true;
  try {
    const result = await request('/api/email/send', { slug: emailDemo.slug, to: $('email-to').value.trim(), subject: $('email-subject').value, message: $('email-message').value });
    $('email-dialog').close(); $('email-form').reset(); showNotice(result.message);
  } catch (error) { $('email-error').textContent = error.message; $('email-error').hidden = false; }
  finally { $('send-email').disabled = false; $('send-email').textContent = 'Send email'; }
};
load();
