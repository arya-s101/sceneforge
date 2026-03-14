import React from 'react';
import './Hero.css';

const Hero: React.FC = () => {
  return (
    <section className="hero">
      <div className="hero-background"></div>
      <div className="container hero-content">
        <div className="badge glass">
          <span>✨ New: Advanced Prompt-to-Data Engine</span>
        </div>
        <h1 className="hero-title">
          Forge Realistic User Data.<br/>
          <span className="text-gradient">From a Single Prompt.</span>
        </h1>
        <p className="hero-description">
          SceneForge is the ultimate QA Sandbox. Generate hyper-realistic user scenarios, mock data, and environments instantly using natural language to supercharge your simulations.
        </p>
        <div className="hero-actions">
          <button className="btn-primary btn-large">Start Forging Free</button>
          <button className="btn-secondary btn-large glass">View Documentation</button>
        </div>
        <div className="hero-stats">
          <div className="stat-item">
            <span className="stat-number">10M+</span>
            <span className="stat-label">Scenarios Generated</span>
          </div>
          <div className="stat-item">
            <span className="stat-number">99.9%</span>
            <span className="stat-label">Uptime Reliability</span>
          </div>
          <div className="stat-item">
            <span className="stat-number">24/7</span>
            <span className="stat-label">AI Availability</span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;
