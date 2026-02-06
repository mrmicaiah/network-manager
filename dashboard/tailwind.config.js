/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bethany: {
          50: '#fdf4f3',
          100: '#fce8e6',
          200: '#f9d4d1',
          300: '#f4b4ae',
          400: '#ec8a80',
          500: '#e06152',
          600: '#cc4435',
          700: '#ab362a',
          800: '#8d3027',
          900: '#752d26',
          950: '#3f140f',
        },
      },
    },
  },
  plugins: [],
};
