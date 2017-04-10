pipeline {
  agent any
  stages {
    stage('install') {
      steps {
        tool(name: 'nodejs', type: 'Node 6.x')
        sh '''npm install
npm install istanbul mocha -g'''
        sh 'istanbul cover --report=json node_modules/mocha/bin/_mocha -- -t 6000 -R spec'
      }
    }
  }
}