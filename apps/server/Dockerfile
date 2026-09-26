# Node.js 24 LTS on Debian bookworm. The major-only tag picks up Node security
# releases on every build; Parse Server 8 supports Node 20, 22 and 24.
FROM node:24-bookworm

# Install LibreOffice for DOCX to PDF conversions
RUN apt-get update \
  && apt-get install -y libreoffice \
  && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY apps/server/package*.json ./

# Install application dependencies.
# npm ci installs exactly what package-lock.json pins (copied by the glob
# above), so two builds of the same commit produce the same dependency tree,
# and --omit=dev keeps eslint, jasmine, nodemon, nyc and prettier out of the
# production image.
RUN npm ci --omit=dev

# If you have native dependencies, you'll need extra tools. Uncomment the following line if needed.
# RUN apk add --no-cache make gcc g++ python3

# Copy the current directory contents into the container
COPY apps/server/ .

# Make port 8080 available to the world outside this container
EXPOSE 8080

# Define environment variables if needed
# ENV NODE_ENV production
# ENV DATABASE_URL mongodb://db:27017

# Run the application
CMD ["npm", "start"]
