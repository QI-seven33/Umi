import {createRoot} from 'react-dom/client';
import App from './App.js';
import './styles/global.css';
import './styles/desktop.css';
import './styles/surface.css';
createRoot(document.getElementById('root')!).render(<App/>);
