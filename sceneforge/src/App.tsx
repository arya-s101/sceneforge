import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import Chatbot from './pages/Chatbot';
import CursorGlow from './components/CursorGlow';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <CursorGlow />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/chat" element={<Chatbot />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
