pipeline {
  agent any
  stages {
    stage('install') {
      steps {
        sh '''npm install
npm install istanbul mocha -g'''
      }
    }
  }
}