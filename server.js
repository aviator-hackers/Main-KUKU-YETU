const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure trust proxy for Render
app.set('trust proxy', 1);

// Middleware
app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Initialize database tables
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id VARCHAR(255) PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                type VARCHAR(100) NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                quantity INTEGER NOT NULL,
                available BOOLEAN DEFAULT true,
                images TEXT[],
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(255) PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                location TEXT NOT NULL,
                latitude DECIMAL(10, 8),
                longitude DECIMAL(11, 8),
                delivery_notes TEXT,
                items JSONB NOT NULL,
                subtotal DECIMAL(10, 2) NOT NULL,
                delivery_fee DECIMAL(10, 2) NOT NULL,
                total DECIMAL(10, 2) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                payment_verified BOOLEAN DEFAULT false,
                transaction_id VARCHAR(255),
                estimated_delivery TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS payments (
                id VARCHAR(255) PRIMARY KEY,
                order_id VARCHAR(255) REFERENCES orders(id),
                amount DECIMAL(10, 2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'KES',
                transaction_id VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                lipiana_response JSONB,
                verified_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        console.log('✅ Database tables initialized successfully');
        
        // Add sample products
        await addSampleProducts();
        
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

// Add sample products
async function addSampleProducts() {
    try {
        const check = await pool.query('SELECT COUNT(*) FROM products');
        if (parseInt(check.rows[0].count) === 0) {
            const sampleProducts = [
                {
                    id: uuidv4(),
                    title: 'Fresh Broiler Chicken',
                    description: 'Freshly processed broiler chicken, perfect for roasting or frying',
                    type: 'broiler',
                    price: 1200,
                    quantity: 50,
                    available: true,
                    images: ['https://images.unsplash.com/photo-1564759224907-65b945ff0e84?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80']
                },
                {
                    id: uuidv4(),
                    title: 'Kienyeji Chicken',
                    description: 'Free-range indigenous chicken, naturally raised',
                    type: 'kienyeji',
                    price: 2500,
                    quantity: 30,
                    available: true,
                    images: ['https://images.unsplash.com/photo-1564759224907-65b945ff0e84?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80']
                },
                {
                    id: uuidv4(),
                    title: 'Fresh Eggs (Tray)',
                    description: '30 fresh eggs from free-range chickens',
                    type: 'eggs',
                    price: 800,
                    quantity: 100,
                    available: true,
                    images: ['https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80']
                },
                {
                    id: uuidv4(),
                    title: 'Whole Turkey',
                    description: 'Large whole turkey for special occasions',
                    type: 'other',
                    price: 4500,
                    quantity: 10,
                    available: true,
                    images: ['https://images.unsplash.com/photo-1564759224907-65b945ff0e84?ixlib=rb-1.2.1&auto=format&fit=crop&w=500&q=80']
                }
            ];
            
            for (const product of sampleProducts) {
                await pool.query(
                    `INSERT INTO products (id, title, description, type, price, quantity, available, images)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [product.id, product.title, product.description, product.type, 
                     product.price, product.quantity, product.available, product.images]
                );
            }
            console.log('✅ Sample products added');
        }
    } catch (error) {
        console.error('❌ Error adding sample products:', error);
    }
}

// Initialize on startup
initializeDatabase();

// ============ PUBLIC ROUTES (NO AUTH NEEDED) ============

// 1. Get all products (Public) - FIXED RESPONSE FORMAT
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products WHERE available = true ORDER BY created_at DESC'
        );
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch products' 
        });
    }
});

// 2. Get single product (Public)
app.get('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Product not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch product' 
        });
    }
});

// 3. Create order (Public) - FIXED
app.post('/api/orders', async (req, res) => {
    try {
        const {
            customerName,
            email,
            phone,
            location,
            latitude,
            longitude,
            deliveryNotes,
            items,
            subtotal,
            deliveryFee,
            total
        } = req.body;
        
        // Validate required fields
        if (!customerName || !email || !phone || !location || !items || !total) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }
        
        const id = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const result = await pool.query(
            `INSERT INTO orders (id, customer_name, email, phone, location, latitude, longitude, 
                               delivery_notes, items, subtotal, delivery_fee, total, transaction_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [id, customerName, email, phone, location, 
             latitude || 0, longitude || 0,
             deliveryNotes || '', 
             JSON.stringify(items), 
             subtotal || 0, 
             deliveryFee || 200, 
             total, 
             transactionId]
        );
        
        res.status(201).json({
            success: true,
            message: 'Order created successfully',
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to create order' 
        });
    }
});

// 4. Get all orders (Public)
app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch orders' 
        });
    }
});

// 5. Update order status (Public)
app.patch('/api/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (!['pending', 'confirmed', 'delivered', 'cancelled'].includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid status'
            });
        }
        
        let estimatedDelivery = null;
        if (status === 'confirmed') {
            estimatedDelivery = new Date(Date.now() + 45 * 60 * 1000);
        }
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = $1, estimated_delivery = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [status, estimatedDelivery, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Order not found' 
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to update order status' 
        });
    }
});

// 6. Create payment (Public)
app.post('/api/payments/create', async (req, res) => {
    try {
        const { orderId, amount } = req.body;
        
        if (!orderId || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Order ID and amount are required'
            });
        }
        
        // Check if order exists
        const orderCheck = await pool.query(
            'SELECT id FROM orders WHERE id = $1',
            [orderId]
        );
        
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }
        
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const paymentId = uuidv4();
        
        await pool.query(
            `INSERT INTO payments (id, order_id, amount, transaction_id, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [paymentId, orderId, amount, transactionId]
        );
        
        res.json({
            success: true,
            paymentId,
            transactionId,
            message: 'Payment initiated'
        });
        
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to create payment' 
        });
    }
});

// 7. Verify payment (Public) - SIMULATED
app.post('/api/payments/verify/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        // Check if order exists
        const orderCheck = await pool.query(
            'SELECT * FROM orders WHERE id = $1',
            [orderId]
        );
        
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }
        
        // Simulate payment verification (always successful for demo)
        const paymentVerified = true;
        
        if (paymentVerified) {
            // Update payment status
            await pool.query(
                `UPDATE payments 
                 SET status = 'completed', verified_at = CURRENT_TIMESTAMP
                 WHERE order_id = $1`,
                [orderId]
            );
            
            // Update order status
            await pool.query(
                `UPDATE orders 
                 SET payment_verified = true, status = 'confirmed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [orderId]
            );
            
            // Get updated order
            const updatedOrder = await pool.query(
                'SELECT * FROM orders WHERE id = $1',
                [orderId]
            );
            
            res.json({
                success: true,
                message: 'Payment verified successfully',
                orderId,
                status: 'confirmed',
                data: updatedOrder.rows[0]
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
        
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to verify payment' 
        });
    }
});

// 8. Dashboard stats (Public)
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [
            totalOrders,
            totalRevenue,
            pendingOrders,
            totalProducts
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM orders'),
            pool.query(`SELECT COALESCE(SUM(total), 0) as revenue FROM orders WHERE status IN ('confirmed', 'delivered')`),
            pool.query("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'"),
            pool.query('SELECT COUNT(*) as count FROM products')
        ]);
        
        res.json({
            success: true,
            data: {
                totalOrders: parseInt(totalOrders.rows[0].count),
                totalRevenue: parseFloat(totalRevenue.rows[0].revenue || 0),
                pendingOrders: parseInt(pendingOrders.rows[0].count),
                totalProducts: parseInt(totalProducts.rows[0].count),
                todayRevenue: parseFloat(totalRevenue.rows[0].revenue || 0) * 0.1, // 10% of total for demo
                totalCustomers: parseInt(totalOrders.rows[0].count) * 0.8 // 80% of orders for demo
            }
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch stats' 
        });
    }
});

// 9. Add/update product (Public)
app.post('/api/products', async (req, res) => {
    try {
        const {
            title,
            description,
            type,
            price,
            quantity,
            available = true,
            images = []
        } = req.body;
        
        if (!title || !description || !type || !price || quantity === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }
        
        const id = uuidv4();
        
        const result = await pool.query(
            `INSERT INTO products (id, title, description, type, price, quantity, available, images)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [id, title, description, type, price, quantity, available, images]
        );
        
        res.status(201).json({
            success: true,
            message: 'Product created successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to create product' 
        });
    }
});

// 10. Update product (Public)
app.put('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title,
            description,
            type,
            price,
            quantity,
            available,
            images
        } = req.body;
        
        // Check if product exists
        const check = await pool.query(
            'SELECT id FROM products WHERE id = $1',
            [id]
        );
        
        if (check.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Product not found' 
            });
        }
        
        const result = await pool.query(
            `UPDATE products 
             SET title = $1, description = $2, type = $3, price = $4, 
                 quantity = $5, available = $6, images = $7, updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [title, description, type, price, quantity, available, images || [], id]
        );
        
        res.json({
            success: true,
            message: 'Product updated successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to update product' 
        });
    }
});

// 11. Delete product (Public)
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(
            'DELETE FROM products WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Product not found' 
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Product deleted successfully' 
        });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to delete product' 
        });
    }
});

// 12. Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'Kuku Yetu API',
        version: '1.0.0',
        endpoints: [
            'GET /api/products',
            'POST /api/orders',
            'GET /api/orders',
            'POST /api/payments/create',
            'POST /api/payments/verify/:orderId',
            'GET /api/dashboard/stats',
            'POST /api/products',
            'PUT /api/products/:id',
            'DELETE /api/products/:id'
        ]
    });
});

// 13. Test endpoint
app.post('/api/test/products', async (req, res) => {
    try {
        await addSampleProducts();
        res.json({
            success: true,
            message: 'Sample products added'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to add sample products'
        });
    }
});

// Root
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Kuku Yetu API is running!',
        endpoints: {
            products: 'GET /api/products',
            orders: 'GET /api/orders',
            createOrder: 'POST /api/orders',
            health: 'GET /api/health',
            test: 'POST /api/test/products'
        }
    });
});

// 404
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 API Base URL: https://main-kuku-yetu.onrender.com`);
    console.log(`📊 Health check: /api/health`);
    console.log(`🛍️  Products: /api/products`);
    console.log(`💳 Orders: /api/orders`);
    console.log(`💰 Payments: /api/payments`);
});
