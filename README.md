# Reelty Backend

The backend service for the Reelty real estate management platform.

## 🚀 Features

- RESTful API endpoints for property management
- Authentication and authorization
- File upload and management
- Payment processing integration
- Real-time notifications
- Database management
- Video processing
- Image optimization
- AWS integration
- Analytics tracking

## 🛠️ Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Authentication:** Clerk
- **Cloud Services:** AWS (S3, SNS)
- **Payment Processing:** Stripe
- **Media Processing:** FFmpeg, Sharp
- **Analytics:** PostHog
- **Language:** TypeScript

## 📦 Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd reelty_backend
```

2. Install dependencies:

```bash
pnpm install
```

3. Set up environment variables:
   Create a `.env` file in the root directory and add necessary environment variables.

4. Initialize the database:

```bash
pnpm db:generate
pnpm db:push
```

## 🚀 Development

Available scripts:

```bash
pnpm dev          # Start development server with hot reload
pnpm build        # Build the project
pnpm start        # Start production server
pnpm db:generate  # Generate Prisma client
pnpm db:push      # Push database changes
pnpm db:migrate   # Run database migrations
pnpm db:seed      # Seed the database
```

## 🏗️ Project Structure

```
reelty_backend/
├── prisma/            # Database schema and migrations
├── src/
│   ├── api/          # API routes and controllers
│   ├── lib/          # Shared libraries and utilities
│   ├── services/     # Business logic
│   ├── types/        # TypeScript type definitions
│   └── server.ts     # Server entry point
├── tests/            # Test files
└── package.json      # Project dependencies and scripts
```

## 🔒 Environment Variables

| Variable            | Description                     |
| ------------------- | ------------------------------- |
| `DATABASE_URL`      | PostgreSQL connection string    |
| `CLERK_SECRET_KEY`  | Clerk authentication secret key |
| `STRIPE_SECRET_KEY` | Stripe secret key               |
| `AWS_ACCESS_KEY_ID` | AWS access key ID               |
| `AWS_SECRET_KEY`    | AWS secret access key           |
| `AWS_REGION`        | AWS region                      |
| `POSTHOG_API_KEY`   | PostHog analytics API key       |
| `RUNWAYML_API_KEY`  | Runway ML API key               |

## 📝 Main Dependencies

- `@clerk/backend`, `@clerk/express` - Authentication and user management
- `@prisma/client` - Database ORM
- `@aws-sdk/*` - AWS services integration
- `stripe` - Payment processing
- `sharp` - Image processing
- `fluent-ffmpeg` - Video processing
- `posthog-node` - Analytics
- `winston` - Logging

## 📚 API Documentation

Once the server is running, you can access:

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## 🧪 Testing

Run tests:

```bash
pnpm test
```

Run tests with coverage:

```bash
pnpm test:cov
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
