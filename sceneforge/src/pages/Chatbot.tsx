import React, { useState } from 'react';
import './Chatbot.css';

const examplePrompts = [
  "Generate 100 users with abandoned carts in the last 24h",
  "Create a mock database of failed login attempts from EU regions",
  "Design a scenario with 50 admins trying to access restricted endpoints",
  "Simulate traffic spike of 5000 users searching for 'wireless headphones'"
];

const previousPrompts: string[] = [];

const Chatbot: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const [isDbModalOpen, setIsDbModalOpen] = useState(false);

  return (
    <div className="chatbot-layout">
      {/* Sidebar */}
      <aside className="chat-sidebar glass">
        <div className="sidebar-header">
          <a href="/" className="logo-link">
            <span className="logo-text">Scene<span className="logo-accent">Forge</span></span>
          </a>
          <button className="new-chat-btn">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
             </svg>
            New Project
          </button>
        </div>
        
        <div className="history-section">
          <h3>Previous Prompts</h3>
          <ul className="history-list">
            {previousPrompts.map((prompt, index) => (
              <li key={index} className="history-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span className="history-text">{prompt}</span>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="sidebar-footer">
          <button className="view-db-btn" onClick={() => setIsDbModalOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
            View Databases
          </button>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-main">
        <header className="chat-header glass">
          <h2>Active Sandbox: <span className="text-secondary">sf-sandbox-01</span></h2>
        </header>

        <div className="chat-content">
          <div className="empty-state">
             <div className="empty-icon glass">
                 <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                 </svg>
             </div>
             <h2>What data shall we forge today?</h2>
             <div className="example-grid">
               {examplePrompts.map((prompt, index) => (
                 <button 
                   key={index} 
                   className="example-btn glass"
                   onClick={() => setInputText(prompt)}
                 >
                   <span className="example-text">"{prompt}"</span>
                   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="example-icon">
                     <line x1="5" y1="12" x2="19" y2="12"></line>
                     <polyline points="12 5 19 12 12 19"></polyline>
                   </svg>
                 </button>
               ))}
             </div>
          </div>
        </div>

        <div className="chat-input-container">
          <div className="input-wrapper glass">
            <input 
              type="text" 
              className="chat-input" 
              placeholder="Describe the user data scenario you want to simulate..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
            <button className="send-btn" disabled={!inputText.trim()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
          <p className="input-footer">SceneForge can make mistakes. Verify test data before production simulations.</p>
        </div>
      </main>

      {/* Databases Modal */}
      {isDbModalOpen && (
        <div className="modal-overlay" onClick={() => setIsDbModalOpen(false)}>
          <div className="modal-content glass" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Generated Databases</h3>
              <button className="close-btn" onClick={() => setIsDbModalOpen(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="empty-db-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: '16px' }}>
                  <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
                </svg>
                <p>No databases have been generated yet.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Chatbot;
