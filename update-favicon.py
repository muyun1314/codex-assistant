#!/usr/bin/env python3
"""Update favicon in ui-frontend.html"""
import os
import re

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.path.join(BASE_DIR, "src-tauri", "resources", "ui-frontend.html")
BASE64_PATH = os.path.join(BASE_DIR, "favicon-base64.txt")

def update_favicon():
    """Update favicon in HTML file"""
    # Read base64 data
    with open(BASE64_PATH, 'r') as f:
        base64_data = f.read().strip()
    
    # Read HTML file
    with open(HTML_PATH, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    # Pattern to match favicon link (data:image/png;base64,...)
    pattern = r'(<link rel="icon" type="image/png" href="data:image/png;base64,)[^"]*(")'
    
    # Replacement
    replacement = r'\g<1>' + base64_data + r'\g<2>'
    
    # Replace
    new_html = re.sub(pattern, replacement, html_content)
    
    # Check if replacement was made
    if new_html == html_content:
        print("❌ No favicon found to replace")
        return False
    
    # Write back
    with open(HTML_PATH, 'w', encoding='utf-8') as f:
        f.write(new_html)
    
    print(f"✅ Updated favicon in {HTML_PATH}")
    print(f"   Base64 length: {len(base64_data)} chars")
    return True

if __name__ == "__main__":
    update_favicon()
