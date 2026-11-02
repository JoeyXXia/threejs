import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
const queryClient = new QueryClient();
createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></StrictMode>);
