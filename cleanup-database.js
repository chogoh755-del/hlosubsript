// ==========================================
// QUICK FIX: Clear Old Admins from Database
// ==========================================

// This script removes all admins so they can re-register with the NEW letters-only format

const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'hlosubscrip';

async function clearOldAdmins() {
    let client;
    try {
        console.log('🔄 Connecting to MongoDB...');
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        
        const db = client.db(DB_NAME);
        const adminsCollection = db.collection('admins');
        
        // Get count before deletion
        const countBefore = await adminsCollection.countDocuments();
        console.log(`📊 Admins before cleanup: ${countBefore}`);
        
        if (countBefore === 0) {
            console.log('✅ Database already clean - no admins to remove');
            await client.close();
            return;
        }
        
        // Show which admins will be deleted
        console.log('\n🗑️  Admins to be deleted:');
        const admins = await adminsCollection.find({}).toArray();
        for (const admin of admins) {
            console.log(`   ❌ ${admin.name} (ID: ${admin.adminId}, Chat: ${admin.chatId})`);
        }
        
        // Delete all admins
        const result = await adminsCollection.deleteMany({});
        console.log(`\n✅ Deleted ${result.deletedCount} admin(s) from database`);
        
        // Verify deletion
        const countAfter = await adminsCollection.countDocuments();
        console.log(`📊 Admins after cleanup: ${countAfter}`);
        
        if (countAfter === 0) {
            console.log('\n🎉 Database cleaned successfully!');
            console.log('📝 Next step: All admins need to re-register');
            console.log('   They will automatically get letters-only IDs (KFPM format)');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        if (client) {
            await client.close();
        }
        process.exit(0);
    }
}

// Run the cleanup
console.log('=' .repeat(50));
console.log('🧹 DATABASE CLEANUP TOOL');
console.log('=' .repeat(50));
console.log('\n⚠️  This will DELETE ALL admins from database!');
console.log('   Admins will need to re-register to get new letters-only IDs\n');

clearOldAdmins();
