#!/bin/bash

# Nykaa Data Pipeline Runner
# This script runs the download and GCP ingestion processes in sequence

echo "Starting Nykaa data pipeline..."
echo "================================"

# Ensure downloads directory exists
mkdir -p downloads

#Step 0: Load the token
# echo "Loading authentication token..."
# node nykka-crawler.js

# if [ $? -ne 0 ]; then
#     echo "✗ Authentication failed"
#     echo "================================"
#     echo "Pipeline failed at authentication step"
#     exit 1
# fi

# Step 1: Download latest data
echo "Step 1: Downloading latest data..."
node download_latest.js

# Check if download was successful
if [ $? -eq 0 ]; then
    echo "✓ Download completed successfully"
    echo ""
    
    # Step 2: Upload to GCP
    echo "Step 2: Uploading to GCP..."
    node gcp-ingestion.js
    
    # Check if GCP ingestion was successful
    if [ $? -eq 0 ]; then
        echo "✓ GCP ingestion completed successfully"
        echo ""
        
        # Step 3: Clear download folder
        echo "Step 3: Clearing download folder..."
        rm -rf downloads/*
        
        if [ $? -eq 0 ]; then
            echo "✓ Download folder cleared successfully"
        else
            echo "⚠ Warning: Failed to clear download folder"
        fi
        
        echo ""
        echo "================================"
        echo "Pipeline completed successfully!"
        exit 0
    else
        echo "✗ GCP ingestion failed"
        echo "================================"
        echo "Pipeline failed at GCP ingestion step"
        exit 1
    fi
else
    echo "✗ Download failed"
    echo "================================"
    echo "Pipeline failed at download step"
    exit 1
fi