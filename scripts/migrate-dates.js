require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

const migrate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB for migration...');

        const transactions = await Transaction.find({ 
            $or: [
                { date: { $exists: false } },
                { date: null }
            ]
        });

        console.log(`Found ${transactions.length} records to update.`);

        let count = 0;
        for (const tx of transactions) {
            tx.date = tx.createdAt;
            await tx.save();
            count++;
        }

        console.log(`Migration complete! Updated ${count} records.`);
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrate();
