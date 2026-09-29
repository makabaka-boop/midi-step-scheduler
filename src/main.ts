import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app mount point');

export default new App({
  target
});
