import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTransport } from './api';
import './styles.css';

void initTransport();
createRoot(document.getElementById('root')!).render(<App />);
