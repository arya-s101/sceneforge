import React from 'react';
import './Features.css';

const featuresData = [
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    ),
    title: 'Prompt-Driven Creation',
    description: 'Provide a simple natural language prompt and our engine converts it into comprehensive user datasets.',
  },
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
    ),
    title: 'Instant Sandbox',
    description: 'Generate hyper-realistic environments with thousands of user personas tailored exactly to your prompt.',
  },
  {
    icon: (
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
        <path d="M3 3v5h5"></path>
      </svg>
    ),
    title: 'Simulation Ready',
    description: 'Export structured data ready to be plugged seamlessly into your testing workflows and QA sandboxes.',
  }
];

const Features: React.FC = () => {
  return (
    <section id="features" className="features">
      <div className="container">
        <div className="features-header">
          <h2 className="section-title">The Engine Behind Your Sandbox</h2>
          <p className="section-subtitle">
            Say goodbye to manual data entry. SceneForge automates context generation for your simulations.
          </p>
        </div>
        
        <div className="features-grid">
          {featuresData.map((feature, index) => (
            <div key={index} className="feature-card glass">
              <div className="feature-icon">{feature.icon}</div>
              <h3 className="feature-title">{feature.title}</h3>
              <p className="feature-description">{feature.description}</p>
            </div>
          ))}
        </div>
        
        <div className="interactive-demo glass">
          <div className="demo-header">
            <span className="dot dot-red"></span>
            <span className="dot dot-yellow"></span>
            <span className="dot dot-green"></span>
            <span className="demo-title">SceneForge Terminal</span>
          </div>
          <div className="demo-body">
            <div className="demo-line">
              <span className="prompt-symbol">&gt;</span> 
              <span className="typing-text">Generate 500 tech-savvy users experiencing a login failure...</span>
            </div>
            <div className="demo-line response delayed-1">
              [SYSTEM] Processing prompt... 
            </div>
            <div className="demo-line response delayed-2">
              [SYSTEM] Generated 500 profiles with context 'login failure'.
            </div>
            <div className="demo-line response delayed-3 json-code">
              {`{
  "sandbox_id": "sf-90210",
  "status": "Ready",
  "data_preview": [ { "user": "Alice", "device": "iOS 17" } ... ]
}`}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Features;
