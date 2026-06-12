import 'dotenv/config.js';
import { BigQuery } from '@google-cloud/bigquery';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BigQueryIngestion {
  constructor(options = {}) {
    this.projectId = options.projectId;
    this.datasetId = options.datasetId;
    this.tableId = options.tableId;
    this.keyFilename = options.keyFilename;
    
    // Initialize BigQuery client
    this.bigquery = new BigQuery({
      projectId: this.projectId,
      keyFilename: this.keyFilename,
    });
    
    // Define schema based on CSV structure
    this.schema = [
      { name: 'date', type: 'DATE', mode: 'NULLABLE' },
      { name: 'seller_code', type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'display_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'company_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'seller_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'brand', type: 'STRING', mode: 'NULLABLE' }, 
      { name: 'sku_code', type: 'STRING', mode: 'NULLABLE' },
      { name: 'sku_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'category_l1', type: 'STRING', mode: 'NULLABLE' },
      { name: 'category_l2', type: 'STRING', mode: 'NULLABLE' },
      { name: 'category_l3', type: 'STRING', mode: 'NULLABLE' },
      { name: 'mrp', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'display_price', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'selling_price', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'total_qty', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'total_orders', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'total_customers', type: 'FLOAT', mode: 'NULLABLE' },
      { name: 'platform', type: 'STRING', mode: 'NULLABLE' },
    ];
  }

  /**
   * Create table if it doesn't exist
   */
  // async createTableIfNotExists() {
  //   try {
  //     const dataset = this.bigquery.dataset(this.datasetId);
  //     const table = dataset.table(this.tableId);
  //     const [exists] = await table.exists();
      
  //     if (!exists) {
  //       console.log(`📊 Creating table: ${this.tableId}`);
  //       await dataset.createTable(this.tableId, {
  //         schema: this.schema,
  //       });
  //       console.log(`✅ Table ${this.tableId} created successfully`);
  //     } else {
  //       console.log(`✅ Table ${this.tableId} already exists`);
        
  //       // Check if table has schema
  //       const [metadata] = await table.getMetadata();
  //       if (!metadata.schema || !metadata.schema.fields || metadata.schema.fields.length === 0) {
  //         console.log(`⚠️  Table exists but has no schema. Updating schema...`);
  //         await table.setMetadata({
  //           schema: this.schema,
  //         });
  //         console.log(`✅ Schema updated successfully`);
  //       }
  //     }
  //   } catch (error) {
  //     console.error('❌ Error creating table:', error.message);
  //     throw error;
  //   }
  // }

  /**
   * Upload CSV file to BigQuery
   */
  async uploadCSV(csvFilePath) {
    try {
      const fileName = path.basename(csvFilePath);
      console.log(`\n📤 Starting upload: ${fileName}`);
      
      // Check if file exists
      if (!fs.existsSync(csvFilePath)) {
        throw new Error(`File not found: ${csvFilePath}`);
      }

      const dataset = this.bigquery.dataset(this.datasetId);
      const table = dataset.table(this.tableId);

      // Configure load job - use existing table schema
      const metadata = {
        sourceFormat: 'CSV',
        skipLeadingRows: 1,
        writeDisposition: 'WRITE_APPEND',
        autodetect: false, // Use existing table schema
        schema: { fields: this.schema },
        allowJaggedRows: true,
        allowQuotedNewlines: true,
        fieldDelimiter: ',',
      };

      // Load data
      await table.load(csvFilePath, metadata);
      console.log(`✅ Upload completed!`);
      
      return {
        success: true,
        fileName: fileName,
      };

    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      return {
        success: false,
        fileName: path.basename(csvFilePath),
        error: error.message,
      };
    }
  }

  /**
   * Upload all CSV files from a directory
   */
  async uploadAllCSVs(directoryPath = './downloads') {
    try {
      console.log(`\n🔍 Scanning directory: ${directoryPath}`);

      if (!fs.existsSync(directoryPath)) {
        console.log(`⚠️  Directory not found: ${directoryPath} — skipping upload`);
        return [];
      }

      const files = fs.readdirSync(directoryPath)
        .filter(file => file.endsWith('.csv'))
        .map(file => path.join(directoryPath, file));

      if (files.length === 0) {
        console.log('⚠️  No CSV files found in directory');
        return [];
      }

      console.log(`📋 Found ${files.length} CSV file(s) to upload`);

      const results = [];
      for (const file of files) {
        const result = await this.uploadCSV(file);
        results.push(result);
        
        // Small delay between uploads to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return results;

    } catch (error) {
      console.error('❌ Error scanning directory:', error.message);
      throw error;
    }
  }

  /**
   * Query data from BigQuery
   */
  async queryData(query) {
    try {
      console.log('\n🔎 Running query...');
      const [rows] = await this.bigquery.query(query);
      console.log(`✅ Query returned ${rows.length} row(s)`);
      return rows;
    } catch (error) {
      console.error('❌ Error running query:', error.message);
      throw error;
    }
  }

  /**
   * Get summary statistics
   */
  async getSummaryStats() {
    const query = `
      SELECT 
        DATE(date) as report_date,
        brand,
        COUNT(*) as total_records,
        SUM(total_qty) as total_quantity,
        SUM(total_orders) as total_orders,
        ROUND(SUM(selling_price), 2) as total_revenue
      FROM \`${this.projectId}.${this.datasetId}.${this.tableId}\`
      GROUP BY report_date, brand
      ORDER BY report_date DESC, brand
      LIMIT 100
    `;

    return await this.queryData(query);
  }
}

// Main execution function
async function main() {
  try {
    console.log('🚀 BigQuery Ingestion Starting...\n');

    // Configuration - Update these values
    const config = {
      projectId: process.env.GCP_PROJECT_ID,
      datasetId: process.env.BQ_DATASET_ID,
      tableId: process.env.BQ_TABLE_ID,
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
    };

    console.log('⚙️  Configuration:');
    console.log(`   Project ID: ${config.projectId}`);
    console.log(`   Dataset: ${config.datasetId}`);
    console.log(`   Table: ${config.tableId}`);
    console.log(`   Key File: ${config.keyFilename}`);
    console.log('');

    // Validate key file exists
    if (!fs.existsSync(config.keyFilename)) {
      throw new Error(`Service account key file not found: ${config.keyFilename}`);
    }

    const ingestion = new BigQueryIngestion(config);

    console.log(`✅ Using existing dataset: ${config.datasetId}\n`);
    
    // Create table if it doesn't exist
    // await ingestion.createTableIfNotExists();
    
    const results = await ingestion.uploadAllCSVs('./downloads');

    // Step 4: Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 UPLOAD SUMMARY');
    console.log('='.repeat(60));
    
    let successCount = 0;
    let failCount = 0;

    results.forEach(result => {
      if (result.success) {
        successCount++;
        console.log(`✅ ${result.fileName}: ${result.rowsLoaded} rows`);
      } else {
        failCount++;
        console.log(`❌ ${result.fileName}: ${result.error}`);
      }
    });

    console.log('\n' + '-'.repeat(60));
    console.log(`Total files processed: ${results.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log('='.repeat(60));

    // Step 5: Show some sample data
    if (successCount > 0) {
      console.log('\n📈 Getting summary statistics...');
      const stats = await ingestion.getSummaryStats();
      
      if (stats.length > 0) {
        console.log('\nTop records by date:');
        stats.slice(0, 10).forEach(row => {
          console.log(`  ${row.report_date}: ${row.brand} - ${row.total_records} records, ${row.total_quantity} units, ₹${row.total_revenue}`);
        });
      }
    }

    console.log('\n✨ Ingestion completed successfully!\n');

  } catch (error) {
    console.error('\n💥 Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Uncaught error:', error);
    process.exit(1);
  });
}

export default BigQueryIngestion;
