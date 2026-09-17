import React from 'react';

export default function Input({ value, onChange, placeholder, type = 'text', className = '' }) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={`w-full bg-muted text-textMain px-4 py-2 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 border border-borderLight placeholder:text-textMuted ${className}`}
    />
  );
}