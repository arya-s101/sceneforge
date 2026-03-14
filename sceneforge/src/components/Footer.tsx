import React from 'react';
import './Footer.css';

const Footer: React.FC = () => {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand">
            <span className="logo-text">Scene<span className="logo-accent">Forge</span></span>
            <p className="footer-tagline">
              The QA Sandbox for the AI Era. Generate limitless user scenarios with a prompt.
            </p>
          </div>
          <div className="footer-links">
            <div className="link-column">
              <h4>Product</h4>
              <a href="#">Sandbox</a>
              <a href="#">Simulations</a>
              <a href="#">Pricing</a>
              <a href="#">Documentation</a>
            </div>
            <div className="link-column">
              <h4>Company</h4>
              <a href="#">About</a>
              <a href="#">Blog</a>
              <a href="#">Careers</a>
              <a href="#">Contact</a>
            </div>
            <div className="link-column">
              <h4>Legal</h4>
              <a href="#">Privacy Policy</a>
              <a href="#">Terms of Service</a>
              <a href="#">Security</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <p>&copy; {new Date().getFullYear()} SceneForge Inc. All rights reserved.</p>
          <div className="social-links">
            <a href="#" className="social-icon">𝕏</a>
            <a href="#" className="social-icon">GH</a>
            <a href="#" className="social-icon">LI</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
