# Reelty Backend

The backend service for the Reelty real estate management platform.

## 🚀 Features

- RESTful API endpoints for property management
- Authentication and authorization
- File upload and management
- Payment processing integration
- Real-time notifications
- Database management
- Caching system
- Background job processing
- API rate limiting
- Logging and monitoring

## 🛠️ Tech Stack

- **Framework:** FastAPI
- **Database:** PostgreSQL
- **ORM:** SQLAlchemy
- **Authentication:** Firebase Admin SDK
- **Task Queue:** Celery
- **Cache:** Redis
- **Storage:** Firebase Storage
- **Payment Processing:** Stripe
- **Testing:** pytest
- **Documentation:** OpenAPI (Swagger)

## 📦 Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd reelty_backend
```

2. Create and activate a virtual environment:

```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:

```bash
pip install -r requirements.txt
```

4. Set up environment variables:
   Create a `.env` file in the root directory and add:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/reelty
FIREBASE_CREDENTIALS_PATH=path/to/firebase-credentials.json
STRIPE_SECRET_KEY=your_stripe_secret_key
REDIS_URL=redis://localhost:6379
```

5. Initialize the database:

```bash
alembic upgrade head
```

## 🚀 Development

Start the development server:

```bash
uvicorn app.main:app --reload
```

The API will be available at `http://localhost:8000`

## 📚 API Documentation

Once the server is running, you can access:

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## 🧪 Testing

Run tests:

```bash
pytest
```

Run tests with coverage:

```bash
pytest --cov=app
```

## 🏗️ Project Structure

```
reelty_backend/
├── alembic/            # Database migrations
├── app/
│   ├── api/           # API endpoints
│   ├── core/          # Core functionality
│   ├── models/        # Database models
│   ├── schemas/       # Pydantic schemas
│   ├── services/      # Business logic
│   └── utils/         # Utility functions
├── tests/             # Test files
├── alembic.ini        # Alembic configuration
└── requirements.txt   # Project dependencies
```

## 🔒 Environment Variables

| Variable                    | Description                                  |
| --------------------------- | -------------------------------------------- |
| `DATABASE_URL`              | PostgreSQL connection string                 |
| `FIREBASE_CREDENTIALS_PATH` | Path to Firebase service account key         |
| `STRIPE_SECRET_KEY`         | Stripe secret key                            |
| `REDIS_URL`                 | Redis connection string                      |
| `LOG_LEVEL`                 | Logging level (default: INFO)                |
| `ENVIRONMENT`               | Runtime environment (development/production) |

## 📝 API Endpoints

### Authentication

- `POST /api/auth/verify` - Verify Firebase token
- `POST /api/auth/refresh` - Refresh access token

### Properties

- `GET /api/properties` - List properties
- `POST /api/properties` - Create property
- `GET /api/properties/{id}` - Get property details
- `PUT /api/properties/{id}` - Update property
- `DELETE /api/properties/{id}` - Delete property

### Users

- `GET /api/users/me` - Get current user
- `PUT /api/users/me` - Update current user
- `GET /api/users/{id}` - Get user details

### Subscriptions

- `GET /api/subscriptions` - List subscriptions
- `POST /api/subscriptions` - Create subscription
- `DELETE /api/subscriptions/{id}` - Cancel subscription

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
