#!/bin/bash
# ============================================================
# Codex Assistant — Release Script
# Builds and publishes a new release to GitHub
# ============================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Codex Assistant Release Script${NC}"
echo "================================"

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is not installed.${NC}"
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo -e "${RED}Error: Not authenticated with GitHub CLI.${NC}"
    echo "Run: gh auth login"
    exit 1
fi

# Read current version
VERSION_FILE="version.json"
if [ ! -f "$VERSION_FILE" ]; then
    echo -e "${RED}Error: version.json not found${NC}"
    exit 1
fi

CURRENT_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE', 'utf-8')).version)")
echo -e "Current version: ${YELLOW}v${CURRENT_VERSION}${NC}"

# Ask for new version
echo ""
echo "Enter new version (e.g., 1.2.0):"
read -r NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
    echo -e "${RED}Error: Version cannot be empty${NC}"
    exit 1
fi

# Validate version format
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}Error: Invalid version format. Use semantic versioning (e.g., 1.2.0)${NC}"
    exit 1
fi

# Ask for changelog
echo ""
echo "Enter changelog (press Enter twice to finish):"
CHANGELOG=""
while IFS= read -r line; do
    [ -z "$line" ] && break
    CHANGELOG="${CHANGELOG}${line}\n"
done

if [ -z "$CHANGELOG" ]; then
    CHANGELOG="Release v${NEW_VERSION}"
fi

# Update version.json
echo ""
echo -e "${YELLOW}Updating version.json...${NC}"
BUILD=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE', 'utf-8')).build || 0)")
NEW_BUILD=$((BUILD + 1))

cat > "$VERSION_FILE" << EOF
{
  "version": "${NEW_VERSION}",
  "build": ${NEW_BUILD},
  "releasedAt": "$(date +%Y-%m-%d)",
  "changelog": "${CHANGELOG}"
}
EOF

echo -e "${GREEN}✓ Updated version.json${NC}"

# Create release archive
echo ""
echo -e "${YELLOW}Creating release archive...${NC}"

RELEASE_DIR="release-temp"
ARCHIVE_NAME="codex-assistant-v${NEW_VERSION}.zip"

# Clean up previous release temp
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Copy files to release directory (excluding dev files)
rsync -av --progress \
    --exclude='.git' \
    --exclude='.gitignore' \
    --exclude='node_modules' \
    --exclude='release-temp' \
    --exclude='.update-*' \
    --exclude='*.log' \
    --exclude='.claude' \
    --exclude='user' \
    --exclude='scripts/release.sh' \
    --exclude='scripts/smoke.sh' \
    --exclude='tests' \
    . "$RELEASE_DIR/codex-assistant/"

# Create zip archive
cd "$RELEASE_DIR"
zip -r "../$ARCHIVE_NAME" codex-assistant/
cd ..

echo -e "${GREEN}✓ Created ${ARCHIVE_NAME}${NC}"

# Clean up release temp
rm -rf "$RELEASE_DIR"

# Commit version changes
echo ""
echo -e "${YELLOW}Committing version changes...${NC}"
git add version.json
git commit -m "release: v${NEW_VERSION}"

# Create git tag
echo ""
echo -e "${YELLOW}Creating git tag...${NC}"
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

# Push changes
echo ""
echo -e "${YELLOW}Pushing changes...${NC}"
git push origin main
git push origin "v${NEW_VERSION}"

# Create GitHub Release
echo ""
echo -e "${YELLOW}Creating GitHub Release...${NC}"
gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --notes "${CHANGELOG}" \
    "$ARCHIVE_NAME"

echo ""
echo -e "${GREEN}✓ Release v${NEW_VERSION} published successfully!${NC}"
echo ""
echo "Release URL:"
gh release view "v${NEW_VERSION}" --json url -q '.url'

# Clean up local archive
rm -f "$ARCHIVE_NAME"

echo ""
echo -e "${GREEN}Done!${NC}"
