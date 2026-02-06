/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary brand color - terracotta
        bethany: {
          50: '#fdf6f4',
          100: '#fceee9',
          200: '#f9d8d0',
          300: '#f4b8a8',
          400: '#ec9278',
          500: '#c4705e', // Main terracotta from marketing site
          600: '#a85c4a', // terracotta-dark
          700: '#8e4d3e',
          800: '#764235',
          900: '#623a30',
          950: '#351b16',
        },
        // Secondary - sage green
        sage: {
          50: '#f4f7f5',
          100: '#e6ede8',
          200: '#cddbd1',
          300: '#a8c4ae', // sage-light
          400: '#7d9b84', // Main sage
          500: '#5c7d63',
          600: '#47634e',
          700: '#3a5040',
          800: '#314236',
          900: '#2a372e',
          950: '#151d18',
        },
        // Accent - golden
        golden: {
          50: '#fdfaf0',
          100: '#faf3db',
          200: '#f5e6b6',
          300: '#efd388',
          400: '#c9a962', // Main golden
          500: '#b8943d',
          600: '#9e7932',
          700: '#7f5e2b',
          800: '#6a4d29',
          900: '#5b4226',
          950: '#342212',
        },
        // Neutrals - warm charcoal palette
        charcoal: {
          DEFAULT: '#2d2a26',
          light: '#4a453d',
          50: '#f8f7f6',
          100: '#f0eeeb',
          200: '#dedad5',
          300: '#c5c0b8',
          400: '#a49d92',
          500: '#8a8277',
          600: '#756d63',
          700: '#605953',
          800: '#514b46',
          900: '#46413d',
          950: '#2d2a26',
        },
        // Background colors
        cream: {
          DEFAULT: '#faf8f5',
          dark: '#f5f1eb',
        },
        'warm-white': '#fefdfb',
        blush: '#e8d5cf',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        body: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 4px 20px rgba(45, 42, 38, 0.08)',
        medium: '0 8px 30px rgba(45, 42, 38, 0.12)',
        warm: '0 4px 20px rgba(196, 112, 94, 0.15)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
};
