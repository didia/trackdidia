'''
Created on 2014-10-25

@author: didia
'''
import unittest
from google.appengine.ext import testbed
from trackdidia.models import  user

class DatastoreTest(unittest.TestCase):


    def setUp(self):
        # First, create an instance of the Testbed class.
        self.testbed = testbed.Testbed()
        # Then activate the testbed, which prepares the service stubs for use.
        self.testbed.activate()
        # Next, declare which service stubs you want to use.
        self.testbed.init_datastore_v3_stub()
        self.testbed.init_memcache_stub()
        self.testbed.init_user_stub()
        self.testbed.init_mail_stub()


    def tearDown(self):
        self.testbed.deactivate()
        

class NormalTest(unittest.TestCase):
    pass

    
class TestTracking(DatastoreTest):
    
    def setUp(self):
        super(TestTracking, self).setUp()
        self.user = user.create_user('TheFuture', 'thefuture2092@gmail.com', 'Aristote')
        self.schedule = self.user.get_schedule()

