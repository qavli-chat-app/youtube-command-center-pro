const navItems = document.querySelectorAll('[data-page]');
const title = document.querySelector('#page-title');
const notice = document.querySelector('#notice');
navItems.forEach((item) => item.addEventListener('click', () => {
  navItems.forEach((node) => node.classList.remove('active'));
  item.classList.add('active');
  title.textContent = item.dataset.page;
  notice.textContent = item.dataset.page + ' is a UI preview. Connect the official YouTube API through a secure backend to enable live data.';
  document.querySelectorAll('.panel-page').forEach((node) => node.hidden = node.id !== 'panel-' + item.dataset.page.toLowerCase().replaceAll(' ', '-'));
}));
document.querySelector('#connect-button').addEventListener('click', () => {
  notice.textContent = 'Google OAuth is not connected yet. The secure backend and OAuth consent setup must be completed before connecting a channel.';
});
document.querySelector('#refresh-button').addEventListener('click', () => {
  notice.textContent = 'Demo preview only: no live YouTube API request was made.';
});
document.querySelector('#upload-button').addEventListener('click', () => {
  notice.textContent = 'Uploads are not enabled in this scaffold. They will use private-by-default uploads after OAuth and backend validation are implemented.';
});