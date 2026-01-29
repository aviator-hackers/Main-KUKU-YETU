const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection (Neon PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
    } else {
        console.log('Connected to PostgreSQL database');
        initializeDatabase();
    }
    release();
});

// Initialize database tables
async function initializeDatabase() {
    try {
        // Create tables if they don't exist
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

            CREATE TABLE IF NOT EXISTS admin_users (
                id VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

            -- Create admin user if not exists
            INSERT INTO admin_users (id, email, password_hash, name)
            SELECT 'admin_001', '${process.env.ADMIN_EMAIL}', '${await bcrypt.hash(process.env.ADMIN_PASSWORD, 10)}', 'Administrator'
            WHERE NOT EXISTS (SELECT 1 FROM admin_users WHERE email = '${process.env.ADMIN_EMAIL}');
        `);
        
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Admin authentication middleware
const authenticateAdmin = async (req, res, next) => {
    const token = req.headers['x-admin-token'];
    
    if (!token) {
        return res.status(401).json({ error: 'Admin token required' });
    }
    
    try {
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE id = $1',
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid admin token' });
        }
        
        req.admin = result.rows[0];
        next();
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
};

// API Routes

// 1. Authentication Routes
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password_hash);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Generate token (in production, use JWT)
        const token = admin.id;
        
        res.json({
            success: true,
            token,
            admin: {
                id: admin.id,
                email: admin.email,
                name: admin.name
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Product Routes
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM products WHERE id = $1',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/products', authenticateAdmin, async (req, res) => {
    try {
        const {
            title,
            description,
            type,
            price,
            quantity,
            available,
            images
        } = req.body;
        
        const id = uuidv4();
        
        const result = await pool.query(
            `INSERT INTO products (id, title, description, type, price, quantity, available, images)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [id, title, description, type, price, quantity, available, images || []]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/products/:id', authenticateAdmin, async (req, res) => {
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
        
        const result = await pool.query(
            `UPDATE products 
             SET title = $1, description = $2, type = $3, price = $4, 
                 quantity = $5, available = $6, images = $7, updated_at = CURRENT_TIMESTAMP
             WHERE id = $8
             RETURNING *`,
            [title, description, type, price, quantity, available, images || [], id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await pool.query(
            'DELETE FROM products WHERE id = $1 RETURNING *',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        
        res.json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. Order Routes
app.get('/api/orders', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM orders WHERE id = $1',
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

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
        
        const id = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const result = await pool.query(
            `INSERT INTO orders (id, customer_name, email, phone, location, latitude, longitude, 
                               delivery_notes, items, subtotal, delivery_fee, total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [id, customerName, email, phone, location, latitude, longitude,
             deliveryNotes || '', items, subtotal, deliveryFee, total]
        );
        
        // In production: Send order confirmation email
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.patch('/api/orders/:id/status', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        let estimatedDelivery = null;
        if (status === 'confirmed') {
            estimatedDelivery = new Date(Date.now() + 45 * 60 * 1000); // 45 minutes from now
        }
        
        const result = await pool.query(
            `UPDATE orders 
             SET status = $1, estimated_delivery = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [status, estimatedDelivery, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // In production: Send status update notification to customer
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 4. Payment Routes (Lipiana.dev Integration)
app.post('/api/payments/create', async (req, res) => {
    try {
        const { orderId, amount, currency, customerEmail, customerPhone, callbackUrl } = req.body;
        
        // Verify order exists
        const orderResult = await pool.query(
            'SELECT * FROM orders WHERE id = $1',
            [orderId]
        );
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        
        // Generate transaction ID
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Save payment record
        const paymentId = uuidv4();
        await pool.query(
            `INSERT INTO payments (id, order_id, amount, currency, transaction_id, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [paymentId, orderId, amount, currency, transactionId, 'pending']
        );
        
        // In production: Call Lipiana API to create payment
        // const lipianaResponse = await axios.post('https://api.lipiana.dev/payments', {
        //     amount,
        //     currency,
        //     transaction_id: transactionId,
        //     customer_email: customerEmail,
        //     customer_phone: customerPhone,
        //     callback_url: callbackUrl,
        //     metadata: { orderId }
        // });
        
        // For demo purposes, return simulated response
        res.json({
            success: true,
            paymentId,
            transactionId,
            checkoutUrl: `https://lipiana.dev/pay/${transactionId}`, // Simulated URL
            message: 'Payment initiated successfully'
        });
        
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/payments/verify/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        // In production: Verify with Lipiana API
        // const lipianaResponse = await axios.get(`https://api.lipiana.dev/payments/verify/${transactionId}`);
        
        // For demo purposes, simulate successful payment
        const paymentVerified = Math.random() > 0.1; // 90% success rate for demo
        
        if (paymentVerified) {
            // Update order payment status
            await pool.query(
                `UPDATE orders 
                 SET payment_verified = true, status = 'confirmed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [orderId]
            );
            
            // Update payment record
            await pool.query(
                `UPDATE payments 
                 SET status = 'completed', verified_at = CURRENT_TIMESTAMP
                 WHERE order_id = $1`,
                [orderId]
            );
            
            res.json({
                success: true,
                message: 'Payment verified successfully',
                orderId,
                status: 'confirmed'
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
        
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 5. Webhook for Lipiana payment notifications (For production)
app.post('/api/webhooks/lipiana', async (req, res) => {
    try {
        // Verify webhook signature (important for security)
        const signature = req.headers['x-lipiana-signature'];
        const payload = JSON.stringify(req.body);
        
        // In production: Verify signature with Lipiana secret
        // const expectedSignature = crypto.createHmac('sha256', process.env.LIPIANA_WEBHOOK_SECRET)
        //                                 .update(payload)
        //                                 .digest('hex');
        // 
        // if (signature !== expectedSignature) {
        //     return res.status(400).json({ error: 'Invalid signature' });
        // }
        
        const { event, data } = req.body;
        
        if (event === 'payment.completed') {
            const { transaction_id, metadata } = data;
            const orderId = metadata?.orderId;
            
            if (orderId) {
                // Update order as paid
                await pool.query(
                    `UPDATE orders 
                     SET payment_verified = true, transaction_id = $1, 
                         status = 'confirmed', updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [transaction_id, orderId]
                );
                
                // Update payment record
                await pool.query(
                    `UPDATE payments 
                     SET status = 'completed', lipiana_response = $1, verified_at = CURRENT_TIMESTAMP
                     WHERE order_id = $2 AND transaction_id = $3`,
                    [data, orderId, transaction_id]
                );
                
                console.log(`Payment completed for order ${orderId}`);
            }
        }
        
        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 6. Dashboard Statistics
app.get('/api/dashboard/stats', authenticateAdmin, async (req, res) => {
    try {
        const [
            totalOrders,
            totalRevenue,
            pendingOrders,
            totalProducts,
            recentOrders
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM orders'),
            pool.query(`SELECT COALESCE(SUM(total), 0) as revenue 
                       FROM orders WHERE status IN ('confirmed', 'delivered')`),
            pool.query("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'"),
            pool.query('SELECT COUNT(*) as count FROM products'),
            pool.query(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 5`)
        ]);
        
        res.json({
            totalOrders: parseInt(totalOrders.rows[0].count),
            totalRevenue: parseFloat(totalRevenue.rows[0].revenue || 0),
            pendingOrders: parseInt(pendingOrders.rows[0].count),
            totalProducts: parseInt(totalProducts.rows[0].count),
            recentOrders: recentOrders.rows
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// 7. Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API Base URL: http://localhost:${PORT}/api`);
});