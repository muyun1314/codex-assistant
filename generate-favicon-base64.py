#!/usr/bin/env python3
"""Generate base64 favicon for HTML embedding"""
from PIL import Image
import base64
import io
import os

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(BASE_DIR, "logo", "新logo.png")

def generate_base64_favicon():
    """Generate base64 encoded favicon"""
    print(f"Loading logo: {LOGO_PATH}")
    img = Image.open(LOGO_PATH)
    
    # Convert to RGBA if not already
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # Resize to 32x32 for favicon
    resized = img.resize((32, 32), Image.Resampling.LANCZOS)
    
    # Save to bytes buffer
    buffer = io.BytesIO()
    resized.save(buffer, format='PNG')
    buffer.seek(0)
    
    # Convert to base64
    base64_data = base64.b64encode(buffer.getvalue()).decode('utf-8')
    
    print(f"Generated base64 favicon (length: {len(base64_data)} chars)")
    print(f"\nFirst 100 chars: {base64_data[:100]}...")
    
    # Save to file for reference
    output_path = os.path.join(BASE_DIR, "favicon-base64.txt")
    with open(output_path, 'w') as f:
        f.write(base64_data)
    print(f"\nSaved to: {output_path}")
    
    return base64_data

if __name__ == "__main__":
    generate_base64_favicon()
