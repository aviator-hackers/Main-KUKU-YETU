const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure trust proxy for Render
app.set('trust proxy', 1);

// Security middleware with Render-compatible settings
app.use(helmet({
    contentSecurityPolicy: false, // Disable for now to avoid issues
    crossOriginEmbedderPolicy: false
}));

// CORS configuration - allow all origins for now (update in production)
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token']
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting with proper Render configuration
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip; // Use IP address for rate limiting
    }
});
app.use('/api/', limiter);

// Database connection (Neon PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
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

            CREATE TABLE IF NOT EXISTS admin_users (
                id VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                token VARCHAR(255),
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
        `);
        
        console.log('Database tables initialized successfully');
        
        // Create default admin if not exists
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@kukuyetu.com';
        const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@2024!';
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        
        await pool.query(`
            INSERT INTO admin_users (id, email, password_hash, name, token)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (email) DO NOTHING
        `, [uuidv4(), adminEmail, hashedPassword, 'Administrator', uuidv4()]);
        
        console.log('Default admin user created');
        
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}

// Initialize database on startup
initializeDatabase();

// Authentication middleware
const authenticateAdmin = async (req, res, next) => {
    try {
        const token = req.headers['x-admin-token'];
        
        if (!token) {
            return res.status(401).json({ 
                success: false,
                error: 'Admin token required' 
            });
        }
        
        // Check if token exists in database
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE token = $1',
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.status(403).json({ 
                success: false,
                error: 'Invalid admin token' 
            });
        }
        
        req.admin = result.rows[0];
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Authentication failed' 
        });
    }
};

// API Routes

// 1. Admin Authentication
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Login attempt for:', email);
        
        // Get admin from database
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            console.log('Admin not found:', email);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }
        
        const admin = result.rows[0];
        
        // Verify password
        const validPassword = await bcrypt.compare(password, admin.password_hash);
        
        if (!validPassword) {
            console.log('Invalid password for:', email);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }
        
        // Generate new token for this session
        const newToken = uuidv4();
        
        // Update token in database
        await pool.query(
            'UPDATE admin_users SET token = $1 WHERE id = $2',
            [newToken, admin.id]
        );
        
        console.log('Login successful for:', email);
        
        res.json({
            success: true,
            token: newToken,
            admin: {
                id: admin.id,
                email: admin.email,
                name: admin.name
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Server error during login' 
        });
    }
});

// 2. Product Routes
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM products ORDER BY created_at DESC'
        );
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
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
            error: 'Server error' 
        });
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
            [id, title, description, type, price, quantity, available || true, images || []]
        );
        
        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
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
        console.error('Error updating product:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
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
            error: 'Server error' 
        });
    }
});

// 3. Order Routes
app.get('/api/orders', authenticateAdmin, async (req, res) => {
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
            error: 'Server error' 
        });
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
        console.error('Error fetching order:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
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
        
        // Validate required fields
        if (!customerName || !email || !phone || !location || !items || !subtotal || !deliveryFee || !total) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }
        
        const id = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        const result = await pool.query(
            `INSERT INTO orders (id, customer_name, email, phone, location, latitude, longitude, 
                               delivery_notes, items, subtotal, delivery_fee, total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [id, customerName, email, phone, location, latitude || 0, longitude || 0,
             deliveryNotes || '', JSON.stringify(items), subtotal, deliveryFee, total]
        );
        
        res.status(201).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
    }
});

app.patch('/api/orders/:id/status', authenticateAdmin, async (req, res) => {
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
            error: 'Server error' 
        });
    }
});

// 4. Payment Routes
app.post('/api/payments/create', async (req, res) => {
    try {
        const { orderId, amount, currency, customerEmail, customerPhone, callbackUrl } = req.body;
        
        // Verify order exists
        const orderResult = await pool.query(
            'SELECT * FROM orders WHERE id = $1',
            [orderId]
        );
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: 'Order not found' 
            });
        }
        
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const paymentId = uuidv4();
        
        await pool.query(
            `INSERT INTO payments (id, order_id, amount, currency, transaction_id, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [paymentId, orderId, amount, currency || 'KES', transactionId, 'pending']
        );
        
        // For demo purposes
        res.json({
            success: true,
            paymentId,
            transactionId,
            checkoutUrl: `https://lipiana.dev/pay/${transactionId}`,
            message: 'Payment initiated successfully'
        });
        
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
    }
});

app.post('/api/payments/verify/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        
        // For demo, simulate 90% success rate
        const paymentVerified = Math.random() > 0.1;
        
        if (paymentVerified) {
            await pool.query(
                `UPDATE orders 
                 SET payment_verified = true, status = 'confirmed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [orderId]
            );
            
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
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
    }
});

// 5. Dashboard Statistics
app.get('/api/dashboard/stats', authenticateAdmin, async (req, res) => {
    try {
        const [
            totalOrders,
            totalRevenue,
            pendingOrders,
            totalProducts
        ] = await Promise.all([
            pool.query('SELECT COUNT(*) as count FROM orders'),
            pool.query(`SELECT COALESCE(SUM(total), 0) as revenue 
                       FROM orders WHERE status IN ('confirmed', 'delivered')`),
            pool.query("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'"),
            pool.query('SELECT COUNT(*) as count FROM products')
        ]);
        
        res.json({
            success: true,
            data: {
                totalOrders: parseInt(totalOrders.rows[0].count),
                totalRevenue: parseFloat(totalRevenue.rows[0].revenue || 0),
                pendingOrders: parseInt(pendingOrders.rows[0].count),
                totalProducts: parseInt(totalProducts.rows[0].count)
            }
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
    }
});

// 6. Test endpoint - add sample products
app.post('/api/test/products', async (req, res) => {
    try {
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
        
        const insertedProducts = [];
        
        for (const product of sampleProducts) {
            const result = await pool.query(
                `INSERT INTO products (id, title, description, type, price, quantity, available, images)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [product.id, product.title, product.description, product.type, 
                 product.price, product.quantity, product.available, product.images]
            );
            insertedProducts.push(result.rows[0]);
        }
        
        res.json({
            success: true,
            message: 'Sample products added successfully',
            data: insertedProducts
        });
        
    } catch (error) {
        console.error('Error adding test products:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server error' 
        });
    }
});

// 7. Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true,
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Kuku Yetu API',
        version: '1.0.0'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to Kuku Yetu API',
        endpoints: {
            health: '/api/health',
            products: '/api/products',
            adminLogin: '/api/admin/login (POST)',
            testProducts: '/api/test/products (POST)'
        },
        docs: 'See documentation for more details'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 API Base URL: https://main-kuku-yetu.onrender.com`);
    console.log(`📊 Health check: https://main-kuku-yetu.onrender.com/api/health`);
    console.log(`🔑 Default admin: ${process.env.ADMIN_EMAIL || 'admin@kukuyetu.com'}`);
});
