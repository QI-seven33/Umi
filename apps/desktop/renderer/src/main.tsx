import {createRoot} from 'react-dom/client';
import App from './App.js';
import './styles/global.css';
import './styles/desktop.css';
import './styles/surface.css';
import './components/ui/interactions.css';
import './file-preview.css';
import './workspace-layout.css';
createRoot(document.getElementById('root')!).render(<App/>);
