'''
Created on 2014-10-25

@author: didia
'''
import unittest
from trackdidia.models import user

from base_test import DatastoreTest


class TestTask(DatastoreTest):

    def setUp(self):
        super(TestTask, self).setUp()
        self.user = user.create_user("101010", "thefuture2092@gmail.com", "didia")
        
    def test_task_update(self):
        name = "GLO-2100"
        second_name = "GLO-2004"
        my_task = self.user.create_task(name=name)
        my_task.update(name=second_name)
        
        same_task = self.user.get_task(task_id=my_task.key.id())
        self.assertEqual(same_task.name, second_name)
         
        
        
    
        
        
        


if __name__ == "__main__":
    # import sys;sys.argv = ['', 'Test.testName']
    unittest.main()
