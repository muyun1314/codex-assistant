#!/usr/bin/env python3
"""Generate Tauri icons from new logo - high quality version"""
from PIL import Image
import struct
import io
import os

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(BASE_DIR, "logo", "新logo.png")
ICONS_DIR = os.path.join(BASE_DIR, "src-tauri", "icons")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
RESOURCES_DIR = os.path.join(BASE_DIR, "src-tauri", "resources")

def create_ico(images, output_path):
    """
    手动创建 ICO 文件，确保包含所有尺寸
    images: list of PIL Image objects
    """
    # ICO 文件头
    header = struct.pack('<HHH', 0, 1, len(images))  # reserved, type=ICO, count
    
    # 准备图像数据
    image_data_list = []
    offset = 6 + 16 * len(images)  # 头部 + 目录条目
    
    directory = b''
    for i, img in enumerate(images):
        # 将图像保存为 PNG 格式（嵌入 ICO）
        png_buffer = io.BytesIO()
        img.save(png_buffer, format='PNG')
        png_data = png_buffer.getvalue()
        
        # 目录条目：width, height, colors, reserved, planes, bpp, size, offset
        w = 0 if img.width >= 256 else img.width
        h = 0 if img.height >= 256 else img.height
        entry = struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png_data), offset)
        directory += entry
        
        image_data_list.append(png_data)
        offset += len(png_data)
    
    # 写入文件
    with open(output_path, 'wb') as f:
        f.write(header)
        f.write(directory)
        for data in image_data_list:
            f.write(data)

def generate_icons():
    """Generate all required icon sizes from the new logo"""
    print(f"Loading logo: {LOGO_PATH}")
    img = Image.open(LOGO_PATH)
    print(f"Original size: {img.size}, mode: {img.mode}")
    
    # Convert to RGBA if not already
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # 确保图片是正方形（添加透明背景）
    max_dim = max(img.size)
    if img.size[0] != img.size[1]:
        print(f"Making image square: {img.size} -> ({max_dim}, {max_dim})")
        square_img = Image.new('RGBA', (max_dim, max_dim), (0, 0, 0, 0))
        offset = ((max_dim - img.size[0]) // 2, (max_dim - img.size[1]) // 2)
        square_img.paste(img, offset)
        img = square_img
    
    # Icon sizes needed for Tauri (使用高质量缩放)
    sizes = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),  # 2x retina
    }
    
    # Generate PNG icons with high quality
    for filename, size in sizes.items():
        output_path = os.path.join(ICONS_DIR, filename)
        # 使用 LANCZOS 高质量缩放
        resized = img.resize(size, Image.Resampling.LANCZOS)
        resized.save(output_path, "PNG", optimize=True)
        print(f"Generated: {filename} ({size[0]}x{size[1]})")
    
    # Generate ICO file with multiple sizes (Windows needs this)
    ico_path = os.path.join(ICONS_DIR, "icon.ico")
    # ICO 文件应该包含多个尺寸以确保清晰度
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    
    # 创建所有尺寸的图片
    ico_images = []
    for size in ico_sizes:
        resized = img.resize(size, Image.Resampling.LANCZOS)
        ico_images.append(resized)
    
    # 使用手动构建方式保存 ICO 文件（Pillow 的 ICO 保存有 bug）
    create_ico(ico_images, ico_path)
    print(f"Generated: icon.ico (sizes: {[s[0] for s in ico_sizes]})")
    
    # Generate favicon for frontend (multiple sizes in one ICO)
    favicon_path = os.path.join(FRONTEND_DIR, "favicon.ico")
    favicon_sizes = [(16, 16), (32, 32), (48, 48)]
    favicon_images = []
    for size in favicon_sizes:
        resized = img.resize(size, Image.Resampling.LANCZOS)
        favicon_images.append(resized)
    
    create_ico(favicon_images, favicon_path)
    print(f"Generated: frontend/favicon.ico")
    
    # Also save as ui-favicon.ico in resources
    ui_favicon_path = os.path.join(RESOURCES_DIR, "ui-favicon.ico")
    create_ico(favicon_images, ui_favicon_path)
    print(f"Generated: resources/ui-favicon.ico")
    
    print("\n✅ All icons generated successfully!")

if __name__ == "__main__":
    generate_icons()
