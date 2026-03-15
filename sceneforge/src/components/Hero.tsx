import React from 'react';
import { Link } from 'react-router-dom';
import './Hero.css';

const Hero: React.FC = () => {
  return (
    <section className="hero">
      <div className="hero-background"></div>
      <div className="container hero-content">
        <h1 className="hero-title">
          Forge Realistic User Data.<br/>
          <span className="text-gradient">From a Single </span>
          <span className="typing-wrapper">
             <span className="typing-hidden-prompt">Prompt</span>
             <span className="typing-prompt">Prompt</span>
             <svg className="squiggly-line" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20" preserveAspectRatio="none">
               <path pathLength="100" d="M0,10 Q6.25,0 12.5,10 T25,10 T37.5,10 T50,10 T62.5,10 T75,10 T87.5,10 T100,10" fill="transparent" stroke="var(--text-primary)" strokeWidth="4" strokeLinecap="round"/>
             </svg>
          </span>
          <span className="text-gradient">.</span>
        </h1>
        <p className="hero-description">
          SceneForge is the ultimate QA Sandbox. Generate hyper-realistic user scenarios, mock data, and environments instantly using natural language to supercharge your simulations.
        </p>
        <div className="hero-actions">
          <Link to="/chat" className="btn-primary btn-large" style={{display: 'inline-block', textDecoration: 'none'}}>Start Forging Free</Link>
        </div>
        <div className="hero-stats">
          <div className="stat-item">
            <span className="stat-number">&lt;2 min</span>
            <span className="stat-label">Sandbox Generation</span>
          </div>
          <div className="stat-item">
            <span className="stat-number">7/7</span>
            <span className="stat-label">Consistency Checks</span>
          </div>
          <div className="stat-item">
            <span className="stat-number">Live</span>
            <span className="stat-label">API Endpoint Testing</span>
          </div>
          <div className="stat-item">
            <span className="stat-number">100%</span>
            <span className="stat-label">Zero Real Data</span>
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
